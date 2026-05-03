from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from urllib import error, parse, request
import threading
import time
import math


@dataclass
class SupabaseTrackingConfig:
    url: str
    service_role_key: str
    table: str = "tracking_locations"
    latest_view: str = "tracking_latest_locations"


def _clean_base_url(raw: str | None) -> str:
    value = (raw or "").strip().rstrip("/")
    if value.endswith("/rest/v1"):
        return value[: -len("/rest/v1")]
    return value


def tracking_config_from_env() -> SupabaseTrackingConfig | None:
    url = _clean_base_url(os.getenv("SUPABASE_URL"))
    key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not url or not key:
        return None
    return SupabaseTrackingConfig(
        url=url,
        service_role_key=key,
        table=(os.getenv("SUPABASE_TRACKING_TABLE") or "tracking_locations").strip(),
        latest_view=(os.getenv("SUPABASE_TRACKING_LATEST_VIEW") or "tracking_latest_locations").strip(),
    )


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _http_json(
    method: str,
    url: str,
    *,
    api_key: str,
    body: Any | None = None,
) -> Any:
    payload = None
    headers = {
        "apikey": api_key,
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
    }
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = request.Request(url, data=payload, method=method, headers=headers)
    with request.urlopen(req, timeout=15) as response:
        raw = response.read().decode("utf-8")
        if not raw:
            return None
        return json.loads(raw)


class SupabaseTrackingStore:
    def __init__(self, config: SupabaseTrackingConfig) -> None:
        self._config = config

    def _rest_url(self, resource: str, query: str = "") -> str:
        base = f"{self._config.url}/rest/v1/{resource}"
        return f"{base}?{query}" if query else base

    def insert_location_update(self, payload: Dict[str, Any]) -> None:
        row = {
            "user_id": payload["user_id"],
            "device_id": payload.get("device_id"),
            "device_name": payload.get("device_name"),
            "latitude": payload["latitude"],
            "longitude": payload["longitude"],
            "timestamp": payload.get("timestamp") or _iso_now(),
        }
        _http_json(
            "POST",
            self._rest_url(self._config.table),
            api_key=self._config.service_role_key,
            body=row,
        )

    def list_latest_locations(self) -> List[Dict[str, Any]]:
        query = parse.urlencode(
            {
                "select": "id,user_id,device_id,device_name,latitude,longitude,timestamp,created_at",
                "order": "timestamp.desc",
            }
        )
        data = _http_json(
            "GET",
            self._rest_url(self._config.latest_view, query),
            api_key=self._config.service_role_key,
        )
        return data if isinstance(data, list) else []

    def list_location_history(
        self,
        *,
        user_id: Optional[str] = None,
        limit: int = 200,
    ) -> List[Dict[str, Any]]:
        params = {
            "select": "id,user_id,device_id,device_name,latitude,longitude,timestamp,created_at",
            "order": "timestamp.desc",
            "limit": str(limit),
        }
        if user_id:
            params["user_id"] = f"eq.{user_id}"
        query = parse.urlencode(params)
        data = _http_json(
            "GET",
            self._rest_url(self._config.table, query),
            api_key=self._config.service_role_key,
        )
        return data if isinstance(data, list) else []


class BufferedTrackingStore:
    """Wraps SupabaseTrackingStore with in-memory per-user buffers and flushing.

    Behavior:
    - `buffer_location_update(payload)` appends a point to a per-user buffer.
    - `flush_user_history(user_id)` flushes buffered points to Supabase in bulk.
    - A background thread periodically flushes buffers that are inactive or exceed limits.
    """

    def __init__(self, config: SupabaseTrackingConfig) -> None:
        self._base = SupabaseTrackingStore(config)
        # buffers: user_id -> list[dict(row)]
        self._buffers: Dict[str, List[Dict[str, Any]]] = {}
        # last updated timestamp per user (epoch seconds)
        self._last_seen: Dict[str, float] = {}
        self._lock = threading.Lock()

        # configuration knobs
        self._max_points_per_user = 1500
        self._inactivity_flush_seconds = 120
        self._periodic_check_seconds = 30
        self._min_movement_meters = 5.0

        self._stopped = False
        self._thread = threading.Thread(target=self._background_loop, daemon=True)
        self._thread.start()

    def _rest_url(self, resource: str, query: str = "") -> str:
        return self._base._rest_url(resource, query)

    def _haversine_meters(self, a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
        # returns distance in meters
        R = 6371000.0
        phi1 = math.radians(a_lat)
        phi2 = math.radians(b_lat)
        dphi = math.radians(b_lat - a_lat)
        dlambda = math.radians(b_lon - a_lon)
        hav = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
        return 2 * R * math.asin(math.sqrt(hav))

    def buffer_location_update(self, payload: Dict[str, Any]) -> None:
        user_id = payload.get("user_id")
        if not user_id:
            return

        lat = payload.get("latitude")
        lon = payload.get("longitude")
        if lat is None or lon is None:
            return

        ts = payload.get("timestamp") or _iso_now()

        row = {
            "user_id": user_id,
            "device_id": payload.get("device_id"),
            "device_name": payload.get("device_name"),
            "latitude": lat,
            "longitude": lon,
            "timestamp": ts,
        }

        with self._lock:
            buf = self._buffers.get(user_id)
            if not buf:
                buf = []
                self._buffers[user_id] = buf

            # movement threshold: drop point if too close to last buffered point
            if buf:
                last = buf[-1]
                try:
                    dist = self._haversine_meters(last["latitude"], last["longitude"], lat, lon)
                except Exception:
                    dist = None
                if dist is not None and dist < self._min_movement_meters:
                    # ignore low-movement point
                    self._last_seen[user_id] = time.time()
                    return

            buf.append(row)
            # trim if too large
            if len(buf) > self._max_points_per_user:
                buf.pop(0)

            self._last_seen[user_id] = time.time()

    def flush_user_history(self, user_id: str) -> None:
        with self._lock:
            buf = self._buffers.get(user_id)
            if not buf:
                return
            payload = list(buf)
            # clear buffer eagerly
            del self._buffers[user_id]
            if user_id in self._last_seen:
                del self._last_seen[user_id]

        # perform bulk insert to Supabase REST (array payload)
        try:
            _http_json(
                "POST",
                self._base._rest_url(self._base._config.table),
                api_key=self._base._config.service_role_key,
                body=payload,
            )
        except Exception:
            # If flush fails, re-buffer (best-effort) to avoid data loss
            with self._lock:
                existing = self._buffers.get(user_id) or []
                self._buffers[user_id] = payload + existing

    def list_latest_locations(self) -> List[Dict[str, Any]]:
        # get from supabase latest view
        data = self._base.list_latest_locations()
        if not isinstance(data, list):
            data = []

        # merge buffered latest points (override by user_id)
        buffered_latest: Dict[str, Dict[str, Any]] = {}
        with self._lock:
            for user_id, buf in self._buffers.items():
                if not buf:
                    continue
                last = buf[-1]
                buffered_latest[user_id] = {
                    "id": None,
                    "user_id": user_id,
                    "device_id": last.get("device_id"),
                    "device_name": last.get("device_name"),
                    "latitude": last.get("latitude"),
                    "longitude": last.get("longitude"),
                    "timestamp": last.get("timestamp"),
                    "created_at": None,
                }

        # replace entries for buffered users
        users_seen = set()
        result: List[Dict[str, Any]] = []
        for row in data:
            uid = row.get("user_id")
            if uid in buffered_latest:
                result.append(buffered_latest[uid])
                users_seen.add(uid)
            else:
                result.append(row)

        # append buffered users not in supabase view
        for uid, row in buffered_latest.items():
            if uid not in users_seen:
                result.append(row)

        return result

    def list_location_history(self, *, user_id: Optional[str] = None, limit: int = 200) -> List[Dict[str, Any]]:
        # fetch from supabase history
        data = self._base.list_location_history(user_id=user_id, limit=limit)
        # if user has buffer, prepend buffered points (most recent first)
        if user_id:
            with self._lock:
                buf = list(self._buffers.get(user_id) or [])
            # newest first
            buf_rev = list(reversed(buf))
            return buf_rev[:limit] + data
        return data

    def _background_loop(self) -> None:
        while not self._stopped:
            now = time.time()
            to_flush: List[str] = []
            with self._lock:
                for user_id, last in list(self._last_seen.items()):
                    if now - last > self._inactivity_flush_seconds:
                        to_flush.append(user_id)
                # also flush if buffer is large (per-user)
                for user_id, buf in list(self._buffers.items()):
                    if len(buf) >= self._max_points_per_user:
                        if user_id not in to_flush:
                            to_flush.append(user_id)

            for uid in to_flush:
                try:
                    self.flush_user_history(uid)
                except Exception:
                    pass

            time.sleep(self._periodic_check_seconds)

    def stop(self) -> None:
        self._stopped = True
        try:
            self._thread.join(timeout=1.0)
        except Exception:
            pass


def tracking_store_from_env() -> SupabaseTrackingStore | None:
    config = tracking_config_from_env()
    if config is None:
        return None
    # return a buffered wrapper that reduces Supabase writes
    return BufferedTrackingStore(config)
