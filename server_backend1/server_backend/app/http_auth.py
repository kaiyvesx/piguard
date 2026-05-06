import os

from fastapi import Header, HTTPException, status


def _extract_bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    if not authorization.startswith("Bearer "):
        return None
    return authorization[7:].strip()


def _auth_required(expected_token_env: str, authorization: str | None) -> None:
    allow_unauth = os.getenv("ALLOW_UNAUTHENTICATED", "false").lower() == "true"
    if allow_unauth:
        return

    expected = os.getenv(expected_token_env, "")
    actual = _extract_bearer(authorization)

    if not expected or not actual or actual != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid bearer token",
        )


def require_mobile_auth(authorization: str | None = Header(default=None)) -> None:
    _auth_required("MOBILE_BEARER_TOKEN", authorization)


def require_admin_auth(authorization: str | None = Header(default=None)) -> None:
    _auth_required("ADMIN_BEARER_TOKEN", authorization)
