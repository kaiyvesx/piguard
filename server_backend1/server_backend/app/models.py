from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, Field


class AdminCommandCreate(BaseModel):
    user_id: str = Field(min_length=1)
    action: str = Field(min_length=1)
    payload: Dict[str, Any] = Field(default_factory=dict)
    source: str = "windows-admin"
    request_id: Optional[str] = Field(
        default=None,
        description="Optional id; becomes command_id when unique. Otherwise server generates one.",
    )


class CommandResponseIn(BaseModel):
    command_id: str
    user_id: str
    action: str
    status: Literal["success", "error"]
    device_id: Optional[str] = None
    device_name: Optional[str] = None
    result: Optional[Dict[str, Any]] = None
    error: Optional[Dict[str, Any]] = None
    executed_at: int


class DeviceLogIn(BaseModel):
    user_id: Optional[str] = None
    device_id: Optional[str] = None
    device_name: Optional[str] = None
    type: Optional[str] = None
    ts: Optional[int] = None

    model_config = {"extra": "allow"}
