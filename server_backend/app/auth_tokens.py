import os


def allow_unauthenticated() -> bool:
    return os.getenv("ALLOW_UNAUTHENTICATED", "false").lower() == "true"


def admin_token_expected() -> str:
    return os.getenv("ADMIN_BEARER_TOKEN", "")


def mobile_token_expected() -> str:
    return os.getenv("MOBILE_BEARER_TOKEN", "")


def validate_admin_token(token: str | None) -> bool:
    if allow_unauthenticated():
        return True
    expected = admin_token_expected()
    return bool(expected and token and token == expected)


def validate_mobile_token(token: str | None) -> bool:
    if allow_unauthenticated():
        return True
    expected = mobile_token_expected()
    return bool(expected and token and token == expected)
