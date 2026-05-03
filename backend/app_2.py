import sys
import re
import json
import webbrowser
import requests
import tempfile

from urllib.parse import quote
from pathlib import Path
from datetime import datetime

from PySide6.QtCore import QTimer, Qt, QThread, Signal
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import (
    QApplication, QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QLineEdit, QTextEdit, QMessageBox, QTabWidget, QListWidget, QListWidgetItem,
    QComboBox, QInputDialog, QGridLayout
)

# ================= CONFIG =================
PI_IP_CANDIDATES = [
    "10.10.218.109",
]
PORT = 8000
BASE = None
# =========================================

EXPORT_DIR = Path(__file__).parent / "downloads"
EXPORT_DIR.mkdir(parents=True, exist_ok=True)


def _detail(resp: requests.Response) -> str:
    try:
        j = resp.json()
        if isinstance(j, dict) and "detail" in j:
            return str(j["detail"])
        return json.dumps(j)
    except Exception:
        return resp.text[:300]


def detect_base(timeout: int = 2) -> str:
    for ip in PI_IP_CANDIDATES:
        base = f"http://{ip}:{PORT}"
        try:
            r = requests.get(base + "/status", timeout=timeout)
            if r.ok:
                return base
        except Exception:
            pass
    raise RuntimeError(
        "Backend not reachable.\n\n"
        f"Tried: {', '.join(PI_IP_CANDIDATES)} (port {PORT})\n\n"
        "Fix:\n"
        "- Backend running on server/Pi (port 8000)\n"
        "- PC & server/Pi connected to the same network or ZeroTier\n"
        "- Correct backend IP is set in app.py\n"
    )


def get_base() -> str:
    global BASE
    if BASE is None:
        BASE = detect_base()
    return BASE


def http_get(path: str, timeout: int = 8):
    r = requests.get(get_base() + path, timeout=timeout)
    if not r.ok:
        raise RuntimeError(f"GET {path} failed ({r.status_code}): {_detail(r)}")
    return r.json()


def http_post(path: str, body: dict = None, timeout: int = 12):
    r = requests.post(get_base() + path, json=(body or {}), timeout=timeout)
    if not r.ok:
        raise RuntimeError(f"POST {path} failed ({r.status_code}): {_detail(r)}")
    return r.json()


def http_put(path: str, body: dict, timeout: int = 12):
    r = requests.put(get_base() + path, json=body, timeout=timeout)
    if not r.ok:
        raise RuntimeError(f"PUT {path} failed ({r.status_code}): {_detail(r)}")
    return r.json()


def http_delete(path: str, timeout: int = 10):
    r = requests.delete(get_base() + path, timeout=timeout)
    if not r.ok:
        raise RuntimeError(f"DELETE {path} failed ({r.status_code}): {_detail(r)}")
    return r.json()


def download_xlsx(api_path: str, prefix: str) -> Path:
    url = get_base() + api_path
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out = EXPORT_DIR / f"{prefix}_{ts}.xlsx"
    r = requests.get(url, timeout=90)
    if not r.ok:
        raise RuntimeError(f"Download failed {r.status_code}: {r.text[:200]}")
    out.write_bytes(r.content)
    return out


def normalize_number(n: str) -> str:
    s = (n or "").strip().replace(" ", "")
    if s.startswith("+63") and len(s) >= 13:
        s = "0" + s[3:]
    return s


def is_valid_ph_mobile(n: str) -> bool:
    return bool(re.fullmatch(r"09\d{9}", n))


def split_numbers(text: str):
    if not text:
        return []
    parts = re.split(r"[,\s]+", text.strip())
    return [p.strip() for p in parts if p.strip()]


def unique(items):
    seen = set()
    out = []
    for x in items:
        x = (x or "").strip()
        if x and x not in seen:
            out.append(x)
            seen.add(x)
    return out


def yn(v):
    if v == 1:
        return "YES"
    if v == 0:
        return "NO"
    return "UNKNOWN"


class MjpegWorker(QThread):
    frame_received = Signal(bytes)
    status_text = Signal(str)

    def __init__(self, url: str):
        super().__init__()
        self.url = url
        self._running = True

    def stop(self):
        self._running = False

    def run(self):
        try:
            with requests.get(self.url, stream=True, timeout=10) as r:
                if not r.ok:
                    self.status_text.emit(f"Stream failed ({r.status_code})")
                    return

                buffer = b""
                for chunk in r.iter_content(chunk_size=4096):
                    if not self._running:
                        break
                    if not chunk:
                        continue

                    buffer += chunk

                    while True:
                        start = buffer.find(b"\xff\xd8")
                        end = buffer.find(b"\xff\xd9")

                        if start != -1 and end != -1 and end > start:
                            jpg = buffer[start:end + 2]
                            buffer = buffer[end + 2:]
                            self.frame_received.emit(jpg)
                        else:
                            break
        except Exception as e:
            self.status_text.emit(f"Stream error: {e}")


class App(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("SIM7000C Control Panel + GPS + SMS Inbox + Cameras + Live View + Export")
        self.resize(1200, 920)

        self.contacts = []
        self.contacts_by_id = {}
        self.groups = []
        self.current_group = None
        self.current_group_members = []
        self._last_gmaps = None
        self.cameras = []

        self.cam0_worker = None
        self.cam2_worker = None

        root = QVBoxLayout()
        self.tabs = QTabWidget()
        root.addWidget(self.tabs)
        self.setLayout(root)

        self._build_status_tab()
        self._build_send_tab()
        self._build_sms_inbox_tab()
        self._build_contacts_tab()
        self._build_groups_tab()
        self._build_logs_tab()
        self._build_gps_tab()
        self._build_cameras_tab()
        self._build_export_tab()

        self.status_timer = QTimer()
        self.status_timer.timeout.connect(self.refresh_status_silent)
        self.status_timer.start(5000)

        self.logs_timer = QTimer()
        self.logs_timer.timeout.connect(self.refresh_logs_silent)
        self.logs_timer.start(5000)

        self.gps_timer = QTimer()
        self.gps_timer.timeout.connect(self.refresh_gps_silent)
        self.gps_timer.start(10000)

        self.sms_inbox_timer = QTimer()
        self.sms_inbox_timer.timeout.connect(self.refresh_sms_inbox_silent)
        self.sms_inbox_timer.start(5000)

        self.safe_boot_refresh()

    def safe_boot_refresh(self):
        try:
            _ = get_base()
            self.refresh_status()
            self.refresh_contacts()
            self.refresh_groups()
            self.refresh_logs()
            self.refresh_sms_inbox()
            self.refresh_gps()
            self.refresh_track_info()
            self.refresh_cameras()
        except Exception as e:
            QMessageBox.critical(self, "Startup Error", str(e))

    # ================= Status Tab =================
    def _build_status_tab(self):
        tab = QWidget()
        layout = QVBoxLayout()

        row = QHBoxLayout()
        btn = QPushButton("Refresh Status Now")
        btn.clicked.connect(self.refresh_status)
        row.addWidget(btn)

        btn_poweroff = QPushButton("Power Off Server/Pi")
        btn_poweroff.clicked.connect(self.poweroff_pi)
        row.addWidget(btn_poweroff)

        row.addStretch()
        layout.addLayout(row)

        self.status_box = QTextEdit()
        self.status_box.setReadOnly(True)
        layout.addWidget(self.status_box)

        tab.setLayout(layout)
        self.tabs.addTab(tab, "Status")

    def refresh_status(self):
        data = http_get("/status", timeout=8)
        self._render_status(data)

    def refresh_status_silent(self):
        try:
            data = http_get("/status", timeout=4)
            self._render_status(data)
        except Exception:
            pass

    def _render_status(self, data: dict):
        at_text = (data.get("AT", "") or "").strip()
        csq_text = (data.get("CSQ", "") or "").strip()
        creg_text = (data.get("CREG", "") or "").strip()
        cops_text = (data.get("COPS", "") or "").strip()
        ip_text = (data.get("CGPADDR", "") or "").strip()
        apn_text = (data.get("APN", "") or "").strip()

        at_meaning = (data.get("AT_MEANING", "") or "").strip()
        csq_meaning = (data.get("CSQ_MEANING", "") or "").strip()
        creg_meaning = (data.get("CREG_MEANING", "") or "").strip()

        hb = data.get("heartbeat") or {}
        hb_status = hb.get("status", "UNKNOWN")
        last_online = hb.get("last_online_ts")
        last_seen = hb.get("last_seen_ts")
        last_online_ago = hb.get("last_online_ago", "unknown")

        power = data.get("power") or {}
        uv_now = yn(power.get("undervoltage_now"))
        uv_boot = yn(power.get("undervoltage_boot"))
        thr_now = yn(power.get("throttling_now"))
        thr_boot = yn(power.get("throttling_boot"))
        thr_raw = power.get("raw", "N/A")

        txt = f"""DEVICE HEARTBEAT
-----------------------
Status: {hb_status}
Last seen: {last_seen}
Last online: {last_online} ({last_online_ago})

POWER STATUS
-----------------------
Undervoltage now: {uv_now}
Undervoltage since boot: {uv_boot}
Throttling now: {thr_now}
Throttling since boot: {thr_boot}
Throttled raw: {thr_raw}

MODEM STATUS SUMMARY
-----------------------
AT meaning: {at_meaning}
CSQ meaning: {csq_meaning}
CREG meaning: {creg_meaning}

MODEM RAW STATUS
-----------------------
BASE: {BASE}
Server time: {data.get('server_time')}

AT:
{at_text}

CSQ:
{csq_text}

CREG:
{creg_text}

COPS:
{cops_text}

CGPADDR:
{ip_text}

APN:
{apn_text}

Contacts: {data.get('contacts_count')}
Groups: {data.get('groups_count')}
{data.get('groups')}
"""
        self.status_box.setPlainText(txt)

    def poweroff_pi(self):
        reply = QMessageBox.question(
            self,
            "Confirm Power Off",
            "Are you sure you want to safely power off the server/Pi?"
        )
        if reply != QMessageBox.Yes:
            return

        try:
            resp = http_post("/system/poweroff", {}, timeout=8)
            QMessageBox.information(
                self,
                "Power Off Started",
                resp.get("message", "Poweroff initiated.")
            )
        except Exception as e:
            QMessageBox.critical(self, "Power Off Error", str(e))

    # ================= Send SMS Tab =================
    def _build_send_tab(self):
        tab = QWidget()
        layout = QVBoxLayout()

        layout.addWidget(QLabel("Recipients (comma/space/newline):"))
        self.to_input = QTextEdit()
        self.to_input.setPlaceholderText("0993...\n0929...\nor 0993...,0929...")
        layout.addWidget(self.to_input)

        row = QHBoxLayout()
        row.addWidget(QLabel("Quick fill from group:"))
        self.send_group_combo = QComboBox()
        self.send_group_combo.setMinimumWidth(260)
        self.send_group_combo.addItem("(Select Group)")
        row.addWidget(self.send_group_combo)

        btn_fill = QPushButton("Use Selected Group Members")
        btn_fill.clicked.connect(self.fill_recipients_from_group)
        row.addWidget(btn_fill)

        btn_clear = QPushButton("Clear Recipients")
        btn_clear.clicked.connect(lambda: self.to_input.setPlainText(""))
        row.addWidget(btn_clear)

        row.addStretch()
        layout.addLayout(row)

        layout.addWidget(QLabel("Message:"))
        self.msg_input = QTextEdit()
        self.msg_input.setPlaceholderText("Type message here...")
        layout.addWidget(self.msg_input)

        row2 = QHBoxLayout()
        btn_send = QPushButton("Send SMS")
        btn_send.clicked.connect(self.send_sms)
        row2.addWidget(btn_send)

        btn_clear_msg = QPushButton("Clear Message")
        btn_clear_msg.clicked.connect(lambda: self.msg_input.setPlainText(""))
        row2.addWidget(btn_clear_msg)

        row2.addStretch()
        layout.addLayout(row2)

        layout.addWidget(QLabel("Send Results:"))
        self.send_result_box = QTextEdit()
        self.send_result_box.setReadOnly(True)
        layout.addWidget(self.send_result_box)

        tab.setLayout(layout)
        self.tabs.addTab(tab, "Send SMS")

    def fill_recipients_from_group(self):
        g = (self.send_group_combo.currentText() or "").strip()
        if not g or g == "(Select Group)":
            QMessageBox.warning(self, "Select Group", "Choose a group first.")
            return
        try:
            data = http_get(f"/groups/{quote(g, safe='')}", timeout=8)
            contacts = data.get("contacts", []) or []
            nums = []
            for c in contacts:
                n = normalize_number(c.get("number", ""))
                if is_valid_ph_mobile(n):
                    nums.append(n)
            nums = unique(nums)
            if not nums:
                QMessageBox.information(self, "No numbers", f"Group '{g}' has no valid numbers.")
                return
            self.to_input.setPlainText("\n".join(nums))
        except Exception as e:
            QMessageBox.critical(self, "Quick Fill Error", str(e))

    def send_sms(self):
        raw = self.to_input.toPlainText()
        msg = self.msg_input.toPlainText().strip()
        if not raw.strip():
            QMessageBox.warning(self, "Missing", "Enter recipients.")
            return
        if not msg:
            QMessageBox.warning(self, "Missing", "Enter a message.")
            return

        numbers = [normalize_number(x) for x in split_numbers(raw)]
        numbers = unique(numbers)
        bad = [n for n in numbers if not is_valid_ph_mobile(n)]
        if bad:
            QMessageBox.warning(self, "Invalid Numbers", "Fix these:\n" + "\n".join(bad))
            return

        try:
            resp = http_post("/send_sms", {"to": numbers, "message": msg}, timeout=60)
            lines = [f"Sent to {len(numbers)} number(s).", ""]
            for d in resp.get("details", []):
                lines.append(f"- {d.get('number')}: {(d.get('resp') or '').replace(chr(10), ' ')[:160]}")
            self.send_result_box.setPlainText("\n".join(lines))
            self.refresh_logs()
        except Exception as e:
            QMessageBox.critical(self, "Send SMS Error", str(e))

    # ================= SMS Inbox Tab =================
    def _build_sms_inbox_tab(self):
        tab = QWidget()
        layout = QVBoxLayout()

        row = QHBoxLayout()
        btn_refresh = QPushButton("Refresh SMS Inbox")
        btn_refresh.clicked.connect(self.refresh_sms_inbox)
        row.addWidget(btn_refresh)
        row.addStretch()
        layout.addLayout(row)

        self.sms_inbox_box = QTextEdit()
        self.sms_inbox_box.setReadOnly(True)
        layout.addWidget(self.sms_inbox_box)

        tab.setLayout(layout)
        self.tabs.addTab(tab, "SMS Inbox")

    def refresh_sms_inbox(self):
        data = http_get("/messages", timeout=8)
        msgs = data.get("sms_inbox", []) or []

        lines = ["=== RECEIVED SMS (last 20) ==="]
        for m in msgs:
            lines.append(f"{m.get('ts')} | FROM {m.get('from_number')}")
            lines.append(f"Message: {m.get('message')}")
            lines.append("-" * 50)

        if len(lines) == 1:
            lines.append("No received SMS yet.")

        self.sms_inbox_box.setPlainText("\n".join(lines))

    def refresh_sms_inbox_silent(self):
        try:
            self.refresh_sms_inbox()
        except Exception:
            pass

    # ================= Contacts Tab =================
    def _build_contacts_tab(self):
        tab = QWidget()
        layout = QVBoxLayout()

        top = QHBoxLayout()
        btn_refresh = QPushButton("Refresh Contacts")
        btn_refresh.clicked.connect(self.refresh_contacts)
        top.addWidget(btn_refresh)
        top.addStretch()
        layout.addLayout(top)

        body = QHBoxLayout()

        left = QVBoxLayout()
        left.addWidget(QLabel("Contacts:"))
        self.contacts_list = QListWidget()
        self.contacts_list.itemSelectionChanged.connect(self.on_contact_selected)
        left.addWidget(self.contacts_list)
        body.addLayout(left, 2)

        right = QVBoxLayout()
        self.contact_id_label = QLabel("ID: (none)")
        right.addWidget(self.contact_id_label)

        r1 = QHBoxLayout()
        r1.addWidget(QLabel("Name:"))
        self.contact_name = QLineEdit()
        r1.addWidget(self.contact_name)
        right.addLayout(r1)

        r2 = QHBoxLayout()
        r2.addWidget(QLabel("Number:"))
        self.contact_number = QLineEdit()
        self.contact_number.setPlaceholderText("09xxxxxxxxx")
        r2.addWidget(self.contact_number)
        right.addLayout(r2)

        btns = QHBoxLayout()
        btn_add = QPushButton("Add")
        btn_add.clicked.connect(self.add_contact)
        btns.addWidget(btn_add)

        btn_update = QPushButton("Update Selected")
        btn_update.clicked.connect(self.update_contact)
        btns.addWidget(btn_update)

        btn_delete = QPushButton("Delete Selected")
        btn_delete.clicked.connect(self.delete_contact)
        btns.addWidget(btn_delete)

        btns.addStretch()
        right.addLayout(btns)

        body.addLayout(right, 3)
        layout.addLayout(body)

        tab.setLayout(layout)
        self.tabs.addTab(tab, "Contacts")

    def refresh_contacts(self):
        data = http_get("/contacts", timeout=8)
        self.contacts = data.get("contacts", [])
        self.contacts_by_id = {c["id"]: c for c in self.contacts}

        self.contacts_list.clear()
        for c in self.contacts:
            it = QListWidgetItem(f'{c["name"]}  —  {c["number"]}')
            it.setData(Qt.UserRole, c["id"])
            self.contacts_list.addItem(it)

        self.rebuild_add_member_combo()
        self.refresh_group_members_list()

    def on_contact_selected(self):
        items = self.contacts_list.selectedItems()
        if not items:
            self.contact_id_label.setText("ID: (none)")
            return
        cid = items[0].data(Qt.UserRole)
        c = self.contacts_by_id.get(cid)
        if not c:
            return
        self.contact_id_label.setText(f"ID: {c['id']}")
        self.contact_name.setText(c["name"])
        self.contact_number.setText(c["number"])

    def add_contact(self):
        name = self.contact_name.text().strip()
        number = normalize_number(self.contact_number.text().strip())
        if not name:
            QMessageBox.warning(self, "Missing", "Name is required.")
            return
        if not is_valid_ph_mobile(number):
            QMessageBox.warning(self, "Invalid", "Number must be 09xxxxxxxxx.")
            return
        try:
            http_post("/contacts", {"name": name, "number": number}, timeout=12)
            self.refresh_contacts()
            self.refresh_groups()
            self.refresh_status()
        except Exception as e:
            QMessageBox.critical(self, "Add Contact Error", str(e))

    def update_contact(self):
        items = self.contacts_list.selectedItems()
        if not items:
            QMessageBox.warning(self, "No selection", "Select a contact first.")
            return
        cid = items[0].data(Qt.UserRole)
        name = self.contact_name.text().strip()
        number = normalize_number(self.contact_number.text().strip())
        if not name:
            QMessageBox.warning(self, "Invalid", "Name cannot be empty.")
            return
        if not is_valid_ph_mobile(number):
            QMessageBox.warning(self, "Invalid", "Number must be 09xxxxxxxxx.")
            return
        try:
            http_put(f"/contacts/{cid}", {"name": name, "number": number}, timeout=12)
            self.refresh_contacts()
        except Exception as e:
            QMessageBox.critical(self, "Update Contact Error", str(e))

    def delete_contact(self):
        items = self.contacts_list.selectedItems()
        if not items:
            QMessageBox.warning(self, "No selection", "Select a contact first.")
            return
        cid = items[0].data(Qt.UserRole)
        reply = QMessageBox.question(self, "Confirm Delete", "Delete this contact?")
        if reply != QMessageBox.Yes:
            return
        try:
            http_delete(f"/contacts/{cid}", timeout=12)
            self.refresh_contacts()
            self.refresh_groups()
            self.refresh_status()
        except Exception as e:
            QMessageBox.critical(self, "Delete Contact Error", str(e))

    # ================= Groups Tab =================
    def _build_groups_tab(self):
        tab = QWidget()
        layout = QVBoxLayout()

        top = QHBoxLayout()
        btn_refresh = QPushButton("Refresh Groups")
        btn_refresh.clicked.connect(self.refresh_groups)
        top.addWidget(btn_refresh)

        btn_create = QPushButton("Create Group")
        btn_create.clicked.connect(self.create_group)
        top.addWidget(btn_create)

        btn_delete = QPushButton("Delete Selected Group")
        btn_delete.clicked.connect(self.delete_group)
        top.addWidget(btn_delete)

        top.addStretch()
        layout.addLayout(top)

        body = QHBoxLayout()

        left = QVBoxLayout()
        left.addWidget(QLabel("Groups:"))
        self.groups_list = QListWidget()
        self.groups_list.itemSelectionChanged.connect(self.on_group_selected)
        left.addWidget(self.groups_list)
        body.addLayout(left, 2)

        right = QVBoxLayout()
        self.group_title = QLabel("Selected Group: (none)")
        right.addWidget(self.group_title)

        right.addWidget(QLabel("Members in this group:"))
        self.group_members_list = QListWidget()
        right.addWidget(self.group_members_list)

        add_row = QHBoxLayout()
        add_row.addWidget(QLabel("Add member:"))
        self.add_member_combo = QComboBox()
        self.add_member_combo.setMinimumWidth(340)
        add_row.addWidget(self.add_member_combo)

        btn_add_mem = QPushButton("Add")
        btn_add_mem.clicked.connect(self.add_member_to_group)
        add_row.addWidget(btn_add_mem)

        btn_remove_mem = QPushButton("Remove Selected")
        btn_remove_mem.clicked.connect(self.remove_member_from_group)
        add_row.addWidget(btn_remove_mem)

        add_row.addStretch()
        right.addLayout(add_row)

        save_row = QHBoxLayout()
        btn_save = QPushButton("Save Group Members")
        btn_save.clicked.connect(self.save_group_members)
        save_row.addWidget(btn_save)

        btn_reload = QPushButton("Reload Group (from backend)")
        btn_reload.clicked.connect(self.reload_current_group)
        save_row.addWidget(btn_reload)

        save_row.addStretch()
        right.addLayout(save_row)

        body.addLayout(right, 4)
        layout.addLayout(body)

        tab.setLayout(layout)
        self.tabs.addTab(tab, "Groups")

    def refresh_groups(self):
        data = http_get("/groups", timeout=8)
        self.groups = data.get("groups", [])

        self.groups_list.clear()
        for g in self.groups:
            it = QListWidgetItem(g)
            it.setData(Qt.UserRole, g)
            self.groups_list.addItem(it)

        self.send_group_combo.clear()
        self.send_group_combo.addItem("(Select Group)")
        for g in self.groups:
            self.send_group_combo.addItem(g)

    def create_group(self):
        name, ok = QInputDialog.getText(self, "Create Group", "Group name:")
        if not ok:
            return
        name = (name or "").strip()
        if not name:
            return
        try:
            http_post("/groups", {"name": name}, timeout=12)
            self.refresh_groups()
            self.refresh_status()
        except Exception as e:
            QMessageBox.critical(self, "Create Group Error", str(e))

    def delete_group(self):
        items = self.groups_list.selectedItems()
        if not items:
            return
        gname = items[0].data(Qt.UserRole)
        reply = QMessageBox.question(self, "Confirm Delete", f"Delete group '{gname}'?")
        if reply != QMessageBox.Yes:
            return
        try:
            http_delete(f"/groups/{quote(gname, safe='')}", timeout=12)
            self.refresh_groups()
            self.refresh_status()
        except Exception as e:
            QMessageBox.critical(self, "Delete Group Error", str(e))

    def on_group_selected(self):
        items = self.groups_list.selectedItems()
        if not items:
            self.current_group = None
            self.current_group_members = []
            self.group_title.setText("Selected Group: (none)")
            self.group_members_list.clear()
            self.rebuild_add_member_combo()
            return
        gname = items[0].data(Qt.UserRole)
        self.load_group(gname)

    def load_group(self, group_name: str):
        data = http_get(f"/groups/{quote(group_name, safe='')}", timeout=8)
        self.current_group = data.get("name")
        self.current_group_members = data.get("members", []) or []
        self.group_title.setText(f"Selected Group: {self.current_group}")

        self.refresh_group_members_list()
        self.rebuild_add_member_combo()

    def reload_current_group(self):
        if self.current_group:
            self.load_group(self.current_group)

    def refresh_group_members_list(self):
        self.group_members_list.clear()
        if not self.current_group_members:
            return
        for cid in self.current_group_members:
            c = self.contacts_by_id.get(cid)
            label = f'{c["name"]}  —  {c["number"]}' if c else f"(Unknown contact) {cid}"
            it = QListWidgetItem(label)
            it.setData(Qt.UserRole, cid)
            self.group_members_list.addItem(it)

    def rebuild_add_member_combo(self):
        self.add_member_combo.clear()
        if not self.contacts:
            self.add_member_combo.addItem("(No contacts)")
            return
        existing = set(self.current_group_members or [])
        candidates = [c for c in self.contacts if c["id"] not in existing]
        if not candidates:
            self.add_member_combo.addItem("(No available contacts)")
            return
        for c in candidates:
            label = f'{c["name"]} — {c["number"]}'
            self.add_member_combo.addItem(label, c["id"])

    def add_member_to_group(self):
        if not self.current_group:
            return
        cid = self.add_member_combo.currentData()
        if not cid or cid in self.current_group_members:
            return
        self.current_group_members.append(cid)
        self.current_group_members = unique(self.current_group_members)
        self.refresh_group_members_list()
        self.rebuild_add_member_combo()

    def remove_member_from_group(self):
        if not self.current_group:
            return
        items = self.group_members_list.selectedItems()
        if not items:
            return
        cid = items[0].data(Qt.UserRole)
        self.current_group_members = [x for x in self.current_group_members if x != cid]
        self.refresh_group_members_list()
        self.rebuild_add_member_combo()

    def save_group_members(self):
        if not self.current_group:
            return
        try:
            http_put(
                f"/groups/{quote(self.current_group, safe='')}",
                {"members": self.current_group_members},
                timeout=15
            )
            QMessageBox.information(self, "Saved", "Group saved.")
            self.refresh_status()
            self.reload_current_group()
        except Exception as e:
            QMessageBox.critical(self, "Save Group Error", str(e))

    # ================= Logs Tab =================
    def _build_logs_tab(self):
        tab = QWidget()
        layout = QVBoxLayout()

        row = QHBoxLayout()
        btn = QPushButton("Refresh Logs Now")
        btn.clicked.connect(self.refresh_logs)
        row.addWidget(btn)
        row.addStretch()
        layout.addLayout(row)

        self.logs_box = QTextEdit()
        self.logs_box.setReadOnly(True)
        layout.addWidget(self.logs_box)

        tab.setLayout(layout)
        self.tabs.addTab(tab, "Logs")

    def refresh_logs(self):
        data = http_get("/messages", timeout=8)
        activity = data.get("activity", []) or []
        sms = data.get("sms", []) or []
        sms_inbox = data.get("sms_inbox", []) or []

        lines = ["=== ACTIVITY (last 20) ==="]
        for a in activity:
            lines.append(f"{a.get('ts')} | {a.get('level')} | {a.get('category')} | {a.get('detail')}")

        lines.append("\n=== SMS SENT LOG (last 20) ===")
        for s in sms:
            lines.append(f"{s.get('ts')} | TO {s.get('number')} | ok={s.get('ok')} | {s.get('message')}")

        lines.append("\n=== SMS INBOX (last 20) ===")
        for s in sms_inbox:
            lines.append(f"{s.get('ts')} | FROM {s.get('from_number')} | {s.get('message')}")

        self.logs_box.setPlainText("\n".join(lines))

    def refresh_logs_silent(self):
        try:
            self.refresh_logs()
        except Exception:
            pass

    # ================= GPS Tab =================
    def _build_gps_tab(self):
        tab = QWidget()
        layout = QVBoxLayout()

        row = QHBoxLayout()
        btn = QPushButton("Refresh GPS")
        btn.clicked.connect(self.refresh_gps)
        row.addWidget(btn)

        btn_restart_gps = QPushButton("Restart GPS")
        btn_restart_gps.clicked.connect(self.restart_gps)
        row.addWidget(btn_restart_gps)

        self.btn_maps = QPushButton("Open Google Maps (Latest Fix)")
        self.btn_maps.setEnabled(False)
        self.btn_maps.clicked.connect(self.open_maps_latest)
        row.addWidget(self.btn_maps)

        btn_track_map = QPushButton("Open Tracker Map (Route)")
        btn_track_map.clicked.connect(self.open_tracker_map)
        row.addWidget(btn_track_map)

        btn_clear = QPushButton("Clear Track")
        btn_clear.clicked.connect(self.clear_track)
        row.addWidget(btn_clear)

        row.addStretch()
        layout.addLayout(row)

        row2 = QHBoxLayout()
        self.track_info = QLabel("Track: (loading...)")
        row2.addWidget(self.track_info)

        btn_track_refresh = QPushButton("Refresh Track Info")
        btn_track_refresh.clicked.connect(self.refresh_track_info)
        row2.addWidget(btn_track_refresh)
        row2.addStretch()
        layout.addLayout(row2)

        self.gps_box = QTextEdit()
        self.gps_box.setReadOnly(True)
        layout.addWidget(self.gps_box)

        tab.setLayout(layout)
        self.tabs.addTab(tab, "GPS Tracker")

    def refresh_gps(self):
        data = http_get("/gps_latest", timeout=8)
        self.render_gps(data)
        self.refresh_track_info()

    def refresh_gps_silent(self):
        try:
            data = http_get("/gps_latest", timeout=4)
            self.render_gps(data)
        except Exception:
            pass

    def restart_gps(self):
        try:
            resp = http_post("/gps/restart", {}, timeout=15)
            QMessageBox.information(
                self,
                "GPS Restarted",
                resp.get("message", "GPS restarted.")
            )
            self.refresh_gps()
        except Exception as e:
            QMessageBox.critical(self, "Restart GPS Error", str(e))

    def render_gps(self, data: dict):
        def show(v, fallback="No data"):
            return fallback if v in (None, "", []) else v

        lines = [
            f"run: {show(data.get('run'))}",
            f"fix: {show(data.get('fix'))}",
            f"utc: {show(data.get('utc'))}",
            f"lat: {show(data.get('lat'))}",
            f"lon: {show(data.get('lon'))}",
            f"alt: {show(data.get('alt'))}",
            f"speed: {show(data.get('speed'))}",
            f"course: {show(data.get('course'))}",
            f"sat: {show(data.get('sat'))}",
        ]

        if data.get("location"):
            lines.append(f"location: {data.get('location')}")
        if data.get("google_maps"):
            lines.append(f"google_maps: {data.get('google_maps')}")

        lines.append("")
        lines.append("raw:")
        lines.append(str(show(data.get("raw"), "No GPS response yet")))
        self.gps_box.setPlainText("\n".join(lines))

        self._last_gmaps = data.get("google_maps")
        self.btn_maps.setEnabled(bool(self._last_gmaps))

    def open_maps_latest(self):
        if self._last_gmaps:
            webbrowser.open(self._last_gmaps)

    def refresh_track_info(self):
        try:
            t = http_get("/gps_track", timeout=12)
            self.track_info.setText(f"Track points: {t.get('count')} | Poll: {t.get('poll_sec')}s")
        except Exception:
            self.track_info.setText("Track: (unavailable)")

    def clear_track(self):
        try:
            http_post("/gps_track/clear", {}, timeout=8)
            QMessageBox.information(self, "Cleared", "GPS track cleared.")
            self.refresh_track_info()
        except Exception as e:
            QMessageBox.critical(self, "Clear Track Error", str(e))

    def open_tracker_map(self):
        try:
            data = http_get("/gps_track", timeout=20)
            points = data.get("points", []) or []
            if len(points) < 1:
                QMessageBox.information(self, "No Track", "No GPS points yet.")
                return
        except Exception as e:
            QMessageBox.critical(self, "Track Error", str(e))
            return

        try:
            import folium
        except Exception:
            QMessageBox.warning(self, "Missing Dependency", "Install folium:\n\npip install folium")
            return

        last = points[-1]
        lat0, lon0 = float(last["lat"]), float(last["lon"])
        m = folium.Map(location=[lat0, lon0], zoom_start=16)
        coords = [(float(p["lat"]), float(p["lon"])) for p in points]
        folium.PolyLine(coords).add_to(m)

        out_path = Path(__file__).parent / "gps_tracker_map.html"
        m.save(str(out_path))
        webbrowser.open(out_path.as_uri())

    # ================= Cameras Tab =================
    def _build_cameras_tab(self):
        tab = QWidget()
        layout = QVBoxLayout()

        top = QHBoxLayout()

        btn_refresh = QPushButton("Refresh Cameras")
        btn_refresh.clicked.connect(self.refresh_cameras)
        top.addWidget(btn_refresh)

        btn_open_cam0 = QPushButton("Open Camera 0 Snapshot")
        btn_open_cam0.clicked.connect(lambda: self.open_camera_snapshot(0))
        top.addWidget(btn_open_cam0)

        btn_open_cam2 = QPushButton("Open Camera 2 Snapshot")
        btn_open_cam2.clicked.connect(lambda: self.open_camera_snapshot(2))
        top.addWidget(btn_open_cam2)

        btn_start_live = QPushButton("Start Live")
        btn_start_live.clicked.connect(self.start_live_views)
        top.addWidget(btn_start_live)

        btn_stop_live = QPushButton("Stop Live")
        btn_stop_live.clicked.connect(self.stop_live_views)
        top.addWidget(btn_stop_live)

        top.addStretch()
        layout.addLayout(top)

        self.cameras_box = QTextEdit()
        self.cameras_box.setReadOnly(True)
        layout.addWidget(self.cameras_box)

        layout.addWidget(QLabel("Live Preview:"))

        grid = QGridLayout()

        self.live_label_cam0 = QLabel("Camera 0 live preview not started")
        self.live_label_cam0.setMinimumSize(420, 300)
        self.live_label_cam0.setAlignment(Qt.AlignCenter)
        self.live_label_cam0.setStyleSheet("border: 1px solid gray;")

        self.live_label_cam2 = QLabel("Camera 2 live preview not started")
        self.live_label_cam2.setMinimumSize(420, 300)
        self.live_label_cam2.setAlignment(Qt.AlignCenter)
        self.live_label_cam2.setStyleSheet("border: 1px solid gray;")

        grid.addWidget(QLabel("Camera 0"), 0, 0)
        grid.addWidget(QLabel("Camera 2"), 0, 1)
        grid.addWidget(self.live_label_cam0, 1, 0)
        grid.addWidget(self.live_label_cam2, 1, 1)

        layout.addLayout(grid)

        tab.setLayout(layout)
        self.tabs.addTab(tab, "Cameras")

    def refresh_cameras(self):
        try:
            data = http_get("/cameras", timeout=12)
            cams = data.get("cameras", []) or []
            self.cameras = cams

            lines = [f"Detected usable cameras: {data.get('count', 0)}", ""]
            for c in cams:
                lines.append(
                    f"device={c.get('device')} | index={c.get('index')} | ok={c.get('ok')} | "
                    f"{c.get('width')}x{c.get('height')} | fps={c.get('fps')}"
                )

            if not cams:
                lines.append("No usable cameras detected.")

            self.cameras_box.setPlainText("\n".join(lines))
        except Exception as e:
            QMessageBox.critical(self, "Camera Refresh Error", str(e))

    def open_camera_snapshot(self, camera_index: int):
        try:
            url = get_base() + f"/camera/{camera_index}/snapshot.jpg"
            r = requests.get(url, timeout=20)
            if not r.ok:
                raise RuntimeError(f"Snapshot failed ({r.status_code}): {r.text[:200]}")

            out = Path(tempfile.gettempdir()) / f"camera_{camera_index}_snapshot.jpg"
            out.write_bytes(r.content)
            webbrowser.open(out.as_uri())
        except Exception as e:
            QMessageBox.critical(self, "Camera Snapshot Error", str(e))

    def start_live_views(self):
        self.stop_live_views()

        self.cam0_worker = MjpegWorker(get_base() + "/camera/0/stream.mjpg")
        self.cam0_worker.frame_received.connect(lambda b: self._set_live_pixmap(self.live_label_cam0, b))
        self.cam0_worker.status_text.connect(lambda t: self.live_label_cam0.setText(t))
        self.cam0_worker.start()

        self.cam2_worker = MjpegWorker(get_base() + "/camera/2/stream.mjpg")
        self.cam2_worker.frame_received.connect(lambda b: self._set_live_pixmap(self.live_label_cam2, b))
        self.cam2_worker.status_text.connect(lambda t: self.live_label_cam2.setText(t))
        self.cam2_worker.start()

    def stop_live_views(self):
        for worker in (self.cam0_worker, self.cam2_worker):
            if worker is not None:
                worker.stop()
                worker.wait(1000)

        self.cam0_worker = None
        self.cam2_worker = None

        self.live_label_cam0.setPixmap(QPixmap())
        self.live_label_cam2.setPixmap(QPixmap())
        self.live_label_cam0.setText("Camera 0 live preview stopped")
        self.live_label_cam2.setText("Camera 2 live preview stopped")

    def _set_live_pixmap(self, label: QLabel, jpg_bytes: bytes):
        pix = QPixmap()
        if not pix.loadFromData(jpg_bytes):
            return

        scaled = pix.scaled(
            label.width(),
            label.height(),
            Qt.KeepAspectRatio,
            Qt.SmoothTransformation
        )
        label.setText("")
        label.setPixmap(scaled)

    def closeEvent(self, event):
        try:
            self.stop_live_views()
        except Exception:
            pass
        event.accept()

    # ================= Export Tab =================
    def _build_export_tab(self):
        tab = QWidget()
        layout = QVBoxLayout()

        layout.addWidget(QLabel(f"Excel downloads saved to:\n{EXPORT_DIR}"))

        row1 = QHBoxLayout()
        row2 = QHBoxLayout()
        row3 = QHBoxLayout()

        b1 = QPushButton("Export NETWORK_STATUS.xlsx")
        b1.clicked.connect(lambda: self.do_export("/export/network_status.xlsx", "network_status"))
        row1.addWidget(b1)

        b2 = QPushButton("Export GPS_POINTS.xlsx")
        b2.clicked.connect(lambda: self.do_export("/export/gps_points.xlsx", "gps_points"))
        row1.addWidget(b2)

        b3 = QPushButton("Export HEARTBEAT.xlsx")
        b3.clicked.connect(lambda: self.do_export("/export/heartbeat.xlsx", "heartbeat"))
        row1.addWidget(b3)

        b4 = QPushButton("Export CONTACTS.xlsx")
        b4.clicked.connect(lambda: self.do_export("/export/contacts.xlsx", "contacts"))
        row2.addWidget(b4)

        b5 = QPushButton("Export GROUPS.xlsx")
        b5.clicked.connect(lambda: self.do_export("/export/groups.xlsx", "groups"))
        row2.addWidget(b5)

        b6 = QPushButton("Export GROUP_MEMBERS.xlsx")
        b6.clicked.connect(lambda: self.do_export("/export/group_members.xlsx", "group_members"))
        row2.addWidget(b6)

        b7 = QPushButton("Export SMS_SENT.xlsx")
        b7.clicked.connect(lambda: self.do_export("/export/sms_sent.xlsx", "sms_sent"))
        row3.addWidget(b7)

        b8 = QPushButton("Export SMS_INBOX.xlsx")
        b8.clicked.connect(lambda: self.do_export("/export/sms_inbox.xlsx", "sms_inbox"))
        row3.addWidget(b8)

        b9 = QPushButton("Export ACTIVITY.xlsx")
        b9.clicked.connect(lambda: self.do_export("/export/activity.xlsx", "activity"))
        row3.addWidget(b9)

        layout.addLayout(row1)
        layout.addLayout(row2)
        layout.addLayout(row3)

        self.export_box = QTextEdit()
        self.export_box.setReadOnly(True)
        layout.addWidget(self.export_box)

        tab.setLayout(layout)
        self.tabs.addTab(tab, "Export")

    def do_export(self, api_path: str, prefix: str):
        try:
            out = download_xlsx(api_path, prefix)
            self.export_box.setPlainText(f"Saved: {out}")
            QMessageBox.information(self, "Export OK", f"Saved:\n{out}")
        except Exception as e:
            QMessageBox.critical(self, "Export Error", str(e))


if __name__ == "__main__":
    app = QApplication(sys.argv)
    w = App()
    w.show()
    sys.exit(app.exec())