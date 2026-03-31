from pydantic import BaseModel, Field
from typing import Any, Dict, Literal, Optional


class AdminCommandCreate(BaseModel):
    device_id: str = Field(min_length=1)
    action: str = Field(min_length=1)
    payload: Dict[str, Any] = Field(default_factory=dict)
    source: str = "windows-admin"


class MobileCommand(BaseModel):
    command_id: str
    device_id: str
    action: str
    payload: Dict[str, Any] = Field(default_factory=dict)
    issued_at: int


class CommandResponseIn(BaseModel):
    command_id: str
    device_id: str
    action: str
    status: Literal["success", "error"]
    result: Optional[Dict[str, Any]] = None
    error: Optional[Dict[str, Any]] = None
    executed_at: int


class DeviceLogIn(BaseModel):
    device_id: Optional[str] = None
    type: Optional[str] = None
    ts: Optional[int] = None

    # Accept arbitrary payload keys for future extensibility.
    model_config = {
        "extra": "allow"
    }
