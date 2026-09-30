"""STIPS Panel fleet, dashboard and managed-device remote manager.

V1.5.8 adds alert activation sources and alert delays while retaining the local-first
dashboard deployment protocol for dedicated STIPS Android wall panels.
"""
from __future__ import annotations

import base64
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
from typing import Any
import uuid

from aiohttp import web
import voluptuous as vol

from homeassistant.components import frontend, websocket_api
from homeassistant.components.http import HomeAssistantView, StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.service import async_register_admin_service
from homeassistant.helpers.storage import Store
from homeassistant.helpers.typing import ConfigType
from homeassistant.util import slugify

from .const import DOMAIN, EVENT_PUSH, MAX_REVISIONS, ONLINE_TIMEOUT_SECONDS, STORAGE_KEY, STORAGE_VERSION

CONFIG_SCHEMA = cv.empty_config_schema(DOMAIN)
SCREEN_ID = vol.All(str, vol.Length(min=4, max=128))
MAX_DIAGNOSTIC_BYTES = 3 * 1024 * 1024
MAX_UPLOAD_CHUNK_BYTES = 768 * 1024
MAX_APK_BYTES = 250 * 1024 * 1024
MAX_BACKUPS = 20

COMMANDS = [
    "reload_dashboard",
    "refresh_entities",
    "reload_configuration",
    "restart_dashboard_ui",
    "reload_metadata",
    "clear_stale_caches",
    "restart_stips",
    "reboot_device",
    "enable_kiosk",
    "disable_kiosk",
    "apply_device_owner_policies",
    "set_device_owner_policies",
    "maintenance_unlock",
    "maintenance_relock",
    "configure_watchdog",
    "set_system_update_policy",
    "request_bug_report",
    "restore_device_config",
    "upload_diagnostics",
    "install_update",
]

REGISTER_SCHEMA = vol.Schema(
    {
        vol.Required("screen_id"): SCREEN_ID,
        vol.Optional("screen_name", default="STIPS Panel"): str,
        vol.Optional("installed_revision", default=0): vol.Coerce(int),
    },
    extra=vol.ALLOW_EXTRA,
)
REPORT_SCHEMA = vol.Schema(
    {
        vol.Required("screen_id"): SCREEN_ID,
        vol.Required("state"): str,
        vol.Optional("installed_revision", default=0): vol.Coerce(int),
        vol.Optional("reported_revision", default=0): vol.Coerce(int),
        vol.Optional("error"): str,
    },
    extra=vol.ALLOW_EXTRA,
)
SYNC_CURRENT_SCHEMA = vol.Schema(
    {
        vol.Required("screen_id"): SCREEN_ID,
        vol.Required("project"): object,
        vol.Optional("installed_revision", default=0): vol.Coerce(int),
    }
)
RECOVERY_SCHEMA = vol.Schema({vol.Required("screen_id"): SCREEN_ID})
PUSH_SCHEMA = vol.Schema(
    {
        vol.Required("screen_id"): SCREEN_ID,
        vol.Required("project"): object,
        vol.Optional("note", default=""): str,
    }
)
ROLLBACK_SCHEMA = vol.Schema(
    {vol.Required("screen_id"): SCREEN_ID, vol.Required("revision"): vol.Coerce(int)}
)
COMMAND_SCHEMA = vol.Schema(
    {
        vol.Required("screen_id"): SCREEN_ID,
        vol.Optional("command", default="reload_dashboard"): vol.In(COMMANDS),
        vol.Optional("data", default={}): dict,
    }
)
REPORT_COMMAND_SCHEMA = vol.Schema(
    {
        vol.Required("screen_id"): SCREEN_ID,
        vol.Required("command"): str,
        vol.Required("state"): str,
        vol.Optional("message", default=""): str,
    },
    extra=vol.ALLOW_EXTRA,
)
REPORT_UPDATE_SCHEMA = vol.Schema(
    {
        vol.Required("screen_id"): SCREEN_ID,
        vol.Optional("update_id", default=""): str,
        vol.Required("phase"): str,
        vol.Optional("progress", default=0): vol.All(vol.Coerce(int), vol.Range(min=0, max=100)),
        vol.Optional("installed_version", default=""): str,
        vol.Optional("available_version", default=""): str,
        vol.Optional("message", default=""): str,
        vol.Optional("error", default=""): str,
    },
    extra=vol.ALLOW_EXTRA,
)
REPORT_DIAGNOSTICS_SCHEMA = vol.Schema(
    {
        vol.Required("screen_id"): SCREEN_ID,
        vol.Optional("filename", default="stips-diagnostics.zip"): str,
        vol.Required("content_base64"): vol.All(str, vol.Length(min=4, max=5 * 1024 * 1024)),
    },
    extra=vol.ALLOW_EXTRA,
)


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _last_seen_age_seconds(value: Any) -> float | None:
    if not value or not isinstance(value, str):
        return None
    try:
        seen = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if seen.tzinfo is None:
            seen = seen.replace(tzinfo=timezone.utc)
        return max(0.0, (datetime.now(timezone.utc) - seen.astimezone(timezone.utc)).total_seconds())
    except (TypeError, ValueError):
        return None


def _is_screen_online(screen: dict[str, Any]) -> bool:
    age = _last_seen_age_seconds(screen.get("last_seen"))
    return age is not None and age <= ONLINE_TIMEOUT_SECONDS


def _screen_with_connectivity(screen: dict[str, Any]) -> dict[str, Any]:
    item = deepcopy(screen)
    age = _last_seen_age_seconds(item.get("last_seen"))
    item["online"] = age is not None and age <= ONLINE_TIMEOUT_SECONDS
    item["connection_state"] = "online" if item["online"] else "offline"
    item["last_seen_age_seconds"] = int(age) if age is not None else None
    item["online_timeout_seconds"] = ONLINE_TIMEOUT_SECONDS
    return item


def _project(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, dict):
        raise vol.Invalid("project must be a JSON object")
    forbidden = {"token", "access_token", "password", "refresh_token", "long_lived_token"}
    stack: list[Any] = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            if any(str(key).lower() in forbidden for key in item):
                raise vol.Invalid("dashboard configuration must not contain credentials")
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)
    return deepcopy(value)


def _project_hash(project: dict[str, Any]) -> str:
    canonical = json.dumps(project, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(canonical).hexdigest()


def _safe_filename(value: str, fallback: str) -> str:
    clean = re.sub(r"[^A-Za-z0-9._-]+", "-", value or "").strip(".-")
    return clean[:120] or fallback


def _dict_from_jsonish(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return deepcopy(value)
    if isinstance(value, str) and value.strip():
        try:
            decoded = json.loads(value)
            return deepcopy(decoded) if isinstance(decoded, dict) else {}
        except (TypeError, ValueError, json.JSONDecodeError):
            return {}
    return {}


def _latest_project(manager: "StipsPanelManager", screen_id: str) -> dict[str, Any] | None:
    screen = manager.data["screens"].get(screen_id, {})
    current = screen.get("current_project")
    if isinstance(current, dict):
        return deepcopy(current)
    desired = manager.data["desired"].get(screen_id)
    if isinstance(desired, dict) and isinstance(desired.get("project"), dict):
        return deepcopy(desired["project"])
    return None


class StipsPanelManager:
    """Persistent screen registry, deployments, backups, profiles and update metadata."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.store: Store[dict[str, Any]] = Store(
            hass, STORAGE_VERSION, STORAGE_KEY, private=True, atomic_writes=True
        )
        self.data: dict[str, Any] = {
            "screens": {},
            "desired": {},
            "revisions": {},
            "templates": {},
            "groups": {},
            "backups": {},
            "profiles": {},
            "updates": {},
            "diagnostics": {},
        }
        base = Path(hass.config.path(".storage", "stips_panel_files"))
        self.update_dir = base / "updates"
        self.diagnostic_dir = base / "diagnostics"
        self.upload_dir = base / "uploads"
        self.upload_sessions: dict[str, dict[str, Any]] = {}

    async def load(self) -> None:
        stored = await self.store.async_load()
        if isinstance(stored, dict):
            for key in self.data:
                if isinstance(stored.get(key), dict):
                    self.data[key] = stored[key]
        self._seed_profiles()
        await self.hass.async_add_executor_job(self._ensure_directories)

    def _ensure_directories(self) -> None:
        self.update_dir.mkdir(parents=True, exist_ok=True)
        self.diagnostic_dir.mkdir(parents=True, exist_ok=True)
        self.upload_dir.mkdir(parents=True, exist_ok=True)

    def _seed_profiles(self) -> None:
        profiles = self.data["profiles"]
        profiles.setdefault(
            "q7",
            {
                "profile_id": "q7",
                "name": "Q7 profile",
                "built_in": True,
                "screen_scale": {
                    "cardScale": 1.25,
                    "textScale": 1.20,
                    "iconScale": 1.15,
                    "spacing": "Comfortable",
                    "columnsOverride": 0,
                },
            },
        )
        profiles.setdefault(
            "4-inch",
            {
                "profile_id": "4-inch",
                "name": "4-inch profile",
                "built_in": True,
                "screen_scale": {
                    "cardScale": 1.00,
                    "textScale": 0.95,
                    "iconScale": 1.00,
                    "spacing": "Compact",
                    "columnsOverride": 0,
                },
            },
        )

    async def save(self) -> None:
        await self.store.async_save(self.data)

    def _screen(self, screen_id: str) -> dict[str, Any]:
        return self.data["screens"].setdefault(
            screen_id,
            {
                "screen_id": screen_id,
                "screen_name": screen_id,
                "installed_revision": 0,
                "state": "offline",
                "last_seen": None,
            },
        )

    @callback
    def _fire_push(self, screen_id: str, revision: int, project: dict[str, Any]) -> None:
        self.hass.bus.async_fire(
            EVENT_PUSH,
            {"screen_id": screen_id, "revision": revision, "project": deepcopy(project)},
        )

    @callback
    def _publish_screen_states(self, screen_id: str) -> None:
        screen = self._screen(screen_id)
        base = f"stips_{slugify(screen.get('screen_name') or screen_id)}"
        common = {"screen_id": screen_id, "screen_name": screen.get("screen_name", screen_id)}

        def sensor(suffix: str, state: Any, unit: str | None = None, attrs: dict[str, Any] | None = None) -> None:
            attributes = {**common, **(attrs or {})}
            if unit:
                attributes["unit_of_measurement"] = unit
            self.hass.states.async_set(f"sensor.{base}_{suffix}", state if state not in (None, "") else "unknown", attributes)

        def binary(suffix: str, value: Any, attrs: dict[str, Any] | None = None) -> None:
            self.hass.states.async_set(
                f"binary_sensor.{base}_{suffix}",
                "on" if bool(value) else "off",
                {**common, **(attrs or {})},
            )

        binary("online", _is_screen_online(screen), {"device_class": "connectivity"})
        binary("device_owner", screen.get("device_owner"))
        binary("ha_socket", screen.get("ha_socket_connected"))
        binary("metadata_loaded", screen.get("metadata_loaded"))
        binary("kiosk_locked", screen.get("lock_task_active"))
        binary("charging", screen.get("battery_charging"))
        binary("screen_on", screen.get("screen_interactive"))
        sensor("app_version", screen.get("app_version", "unknown"))
        sensor("wifi_signal", screen.get("wifi_rssi_dbm"), "dBm")
        sensor("battery", screen.get("battery_level"), "%")
        sensor("memory_used", screen.get("memory_used_mb"), "MB")
        sensor("storage_free", screen.get("storage_free_mb"), "MB")
        sensor("storage_total", screen.get("storage_total_mb"), "MB")
        sensor("brightness", screen.get("system_brightness"))
        sensor("orientation", screen.get("screen_orientation", screen.get("orientation", "unknown")))
        sensor("screen_timeout", screen.get("screen_timeout_minutes"), "min")
        sensor("uptime", screen.get("uptime_seconds"), "s")
        sensor("app_uptime", screen.get("app_uptime_seconds"), "s")
        sensor("temperature", screen.get("temperature_c"), "°C")
        sensor("ip_address", screen.get("ip_address", "unknown"))
        sensor("last_ha_rx", screen.get("last_ha_rx_epoch_ms", "unknown"))
        sensor("system_update_policy", screen.get("system_update_policy", "unknown"))
        sensor("watchdog", screen.get("health_state", "unknown"), attrs={"message": screen.get("health_message", "")})

    async def register_screen(self, call: ServiceCall) -> None:
        screen_id = call.data["screen_id"]
        screen = self._screen(screen_id)
        # ALLOW_EXTRA is deliberate: newer Android builds can add telemetry without requiring a
        # Home Assistant component release merely to persist/display a new read-only field.
        payload = deepcopy(dict(call.data))
        payload.pop("screen_id", None)
        screen.update(payload)
        screen["screen_name"] = payload.get("screen_name") or screen.get("screen_name") or screen_id
        screen["installed_revision"] = int(payload.get("installed_revision", screen.get("installed_revision", 0)))
        screen["state"] = "online"
        screen["last_seen"] = _utcnow()
        screen["last_error"] = None

        latest = self.data["updates"].get("latest")
        if isinstance(latest, dict):
            screen["available_version"] = latest.get("version_name", "")
            screen["update_available"] = bool(
                latest.get("version_name") and latest.get("version_name") != screen.get("app_version")
            )

        desired = self.data["desired"].get(screen_id)
        if desired and int(desired["revision"]) > int(screen.get("installed_revision", 0)):
            screen["state"] = "pending_update"
            screen["pending_revision"] = int(desired["revision"])
            self._fire_push(screen_id, int(desired["revision"]), desired["project"])
        else:
            screen["pending_revision"] = None
            screen["state"] = "up_to_date"

        # OTA requests are durable fleet intent. If a panel was offline when Update All/selected
        # was pressed, re-deliver the requested APK when that screen registers again. The Android
        # client de-duplicates an update already in download/verify/install.
        desired_update_id = str(screen.get("desired_update_id") or "")
        desired_update = self.data["updates"].get(desired_update_id) if desired_update_id else None
        if isinstance(desired_update, dict) and screen.get("app_version") != desired_update.get("version_name"):
            update_payload = {k: deepcopy(v) for k, v in desired_update.items() if k != "path"}
            update_payload["force"] = bool(screen.get("desired_update_force", False))
            event = {"screen_id": screen_id, "command": "install_update", **update_payload}
            screen["last_command"] = "install_update"
            screen["last_command_state"] = "sent"
            screen["last_command_message"] = "Delivering pending OTA request"
            screen["last_command_at"] = _utcnow()
            self.hass.bus.async_fire("stips_panel_command", event)

        self._publish_screen_states(screen_id)
        await self.save()

    async def sync_current(self, call: ServiceCall) -> None:
        screen_id = call.data["screen_id"]
        screen = self._screen(screen_id)
        project = _project(call.data["project"])
        previous_project = deepcopy(screen.get("current_project")) if isinstance(screen.get("current_project"), dict) else None
        old_hash = screen.get("current_project_hash")
        new_hash = _project_hash(project)
        if previous_project is not None and old_hash and old_hash != new_hash:
            await self.create_backup(screen_id, label="Automatic pre-sync backup", project_override=previous_project)
        screen["current_project"] = project
        screen["current_project_hash"] = new_hash
        screen["installed_revision"] = int(call.data.get("installed_revision", screen.get("installed_revision", 0)))
        screen["last_seen"] = _utcnow()
        await self.save()

    async def request_recovery(self, call: ServiceCall) -> None:
        screen_id = call.data["screen_id"]
        screen = self._screen(screen_id)
        desired = self.data["desired"].get(screen_id)
        project = desired.get("project") if isinstance(desired, dict) else None
        revision = int(desired.get("revision", 0)) if isinstance(desired, dict) else 0
        if not isinstance(project, dict):
            project = screen.get("current_project")
            revision = max(int(screen.get("installed_revision", 0)), 1)
        if not isinstance(project, dict):
            return
        screen["state"] = "recovering"
        self._fire_push(screen_id, max(revision, 1), project)
        await self.save()

    async def report_status(self, call: ServiceCall) -> None:
        screen_id = call.data["screen_id"]
        screen = self._screen(screen_id)
        installed = int(call.data.get("installed_revision", screen.get("installed_revision", 0)))
        screen.update(deepcopy(dict(call.data)))
        screen.update(
            {
                "installed_revision": installed,
                "last_seen": _utcnow(),
                "last_error": call.data.get("error"),
                "reported_revision": int(call.data.get("reported_revision", 0)),
            }
        )
        desired = self.data["desired"].get(screen_id)
        if desired and installed >= int(desired["revision"]):
            screen["pending_revision"] = None
            if screen.get("state") != "update_failed":
                screen["state"] = "up_to_date"
        self._publish_screen_states(screen_id)
        await self.save()

    async def report_command(self, call: ServiceCall) -> None:
        screen_id = call.data["screen_id"]
        screen = self._screen(screen_id)
        screen.update(
            {
                "last_command": call.data["command"],
                "last_command_state": call.data["state"],
                "last_command_message": call.data.get("message", ""),
                "last_command_at": _utcnow(),
                "last_seen": _utcnow(),
            }
        )
        await self.save()

    async def report_update(self, call: ServiceCall) -> None:
        screen_id = call.data["screen_id"]
        screen = self._screen(screen_id)
        update = {
            "update_id": call.data.get("update_id", ""),
            "phase": call.data["phase"],
            "progress": int(call.data.get("progress", 0)),
            "installed_version": call.data.get("installed_version", screen.get("app_version", "")),
            "available_version": call.data.get("available_version", ""),
            "message": call.data.get("message", ""),
            "error": call.data.get("error", ""),
            "updated": _utcnow(),
        }
        screen["ota"] = update
        screen["last_seen"] = _utcnow()
        if update["installed_version"]:
            screen["app_version"] = update["installed_version"]
        if update["phase"] in {"failed", "error"}:
            screen["last_error"] = update["error"] or update["message"]
        elif update["phase"] == "installed":
            screen["last_error"] = None
        if update["phase"] in {"installed", "failed", "error"} and (
            not update["update_id"] or update["update_id"] == screen.get("desired_update_id")
        ):
            screen.pop("desired_update_id", None)
            screen.pop("desired_update_force", None)
        self._publish_screen_states(screen_id)
        await self.save()

    async def report_diagnostics(self, call: ServiceCall) -> None:
        screen_id = call.data["screen_id"]
        try:
            raw = base64.b64decode(call.data["content_base64"], validate=True)
        except Exception as err:
            raise vol.Invalid("content_base64 is not valid base64") from err
        if len(raw) > MAX_DIAGNOSTIC_BYTES:
            raise vol.Invalid("diagnostic package exceeds 3 MB limit")
        filename = _safe_filename(call.data.get("filename", ""), f"{screen_id}-diagnostics.zip")
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = self.diagnostic_dir / f"{_safe_filename(screen_id, 'screen')}-{stamp}-{filename}"
        await self.hass.async_add_executor_job(path.write_bytes, raw)
        item = {
            "screen_id": screen_id,
            "filename": path.name,
            "path": str(path),
            "size_bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "created": _utcnow(),
        }
        self.data["diagnostics"][screen_id] = item
        screen = self._screen(screen_id)
        screen["last_diagnostic"] = {k: v for k, v in item.items() if k != "path"}
        await self.save()

    async def push(self, screen_id: str, project: Any, note: str = "") -> dict[str, Any]:
        project_obj = _project(project)
        screen = self._screen(screen_id)
        old_desired = self.data["desired"].get(screen_id)
        current = max(
            int(screen.get("installed_revision", 0)),
            int(old_desired.get("revision", 0)) if old_desired else 0,
            max((int(x.get("revision", 0)) for x in self.data["revisions"].get(screen_id, [])), default=0),
        )
        revision = current + 1
        item = {
            "revision": revision,
            "created": _utcnow(),
            "note": note,
            "project": project_obj,
        }
        revisions = self.data["revisions"].setdefault(screen_id, [])
        revisions.append(deepcopy(item))
        del revisions[:-MAX_REVISIONS]
        self.data["desired"][screen_id] = deepcopy(item)
        screen["pending_revision"] = revision
        screen["state"] = "updating" if _is_screen_online(screen) else "pending_update"
        await self.save()
        self._fire_push(screen_id, revision, project_obj)
        return item

    async def rollback(self, screen_id: str, revision: int) -> dict[str, Any]:
        source = next(
            (x for x in self.data["revisions"].get(screen_id, []) if int(x["revision"]) == revision),
            None,
        )
        if source is None:
            raise vol.Invalid(f"Revision {revision} was not found for {screen_id}")
        return await self.push(screen_id, source["project"], note=f"Rollback of revision {revision}")

    async def command(self, screen_id: str, command: str, data: dict[str, Any] | None = None) -> None:
        if command not in COMMANDS:
            raise vol.Invalid(f"Unsupported STIPS command: {command}")
        screen = self._screen(screen_id)
        screen.update(
            {
                "last_command": command,
                "last_command_state": "sent",
                "last_command_message": "Waiting for panel acknowledgement",
                "last_command_at": _utcnow(),
            }
        )
        await self.save()
        event = {"screen_id": screen_id, "command": command}
        event.update(deepcopy(data or {}))
        self.hass.bus.async_fire("stips_panel_command", event)

    async def save_template(self, template_id: str, name: str, project: Any) -> dict[str, Any]:
        item = {
            "template_id": template_id,
            "name": name,
            "updated": _utcnow(),
            "project": _project(project),
        }
        self.data["templates"][template_id] = item
        await self.save()
        return item

    async def delete_template(self, template_id: str) -> None:
        self.data["templates"].pop(template_id, None)
        await self.save()

    async def create_backup(
        self, screen_id: str, label: str = "Manual backup", project_override: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        screen = self._screen(screen_id)
        project = deepcopy(project_override) if isinstance(project_override, dict) else _latest_project(self, screen_id)
        if not isinstance(project, dict):
            raise vol.Invalid("No project is available to back up for this screen")
        config = _dict_from_jsonish(screen.get("device_config_json"))
        item = {
            "backup_id": uuid.uuid4().hex[:12],
            "created": _utcnow(),
            "label": label,
            "project_hash": _project_hash(project),
            "project": project,
            "device_config": config,
            "policies": {
                "auto_apply": bool(screen.get("policy_auto_apply", False)),
                "protect_uninstall": bool(screen.get("uninstall_blocked", False)),
                "persistent_home": bool(screen.get("default_launcher", False)),
                "disable_keyguard": bool(screen.get("policy_disable_keyguard", False)),
                "block_safe_boot": bool(screen.get("block_safe_boot", False)),
                "block_add_user": bool(screen.get("block_add_user", False)),
                "block_factory_reset": bool(screen.get("block_factory_reset", False)),
            },
        }
        backups = self.data["backups"].setdefault(screen_id, [])
        # Avoid unbounded duplicate heartbeat/sync backups.
        if backups and backups[-1].get("project_hash") == item["project_hash"] and label.startswith("Automatic"):
            return backups[-1]
        backups.append(item)
        del backups[:-MAX_BACKUPS]
        await self.save()
        return item

    async def restore_backup(self, screen_id: str, backup_id: str) -> dict[str, Any]:
        backup = next(
            (x for x in self.data["backups"].get(screen_id, []) if x.get("backup_id") == backup_id),
            None,
        )
        if not backup:
            raise vol.Invalid("Backup was not found")
        pushed = await self.push(screen_id, backup["project"], note=f"Restore backup {backup_id}")
        if backup.get("device_config"):
            await self.command(screen_id, "restore_device_config", backup["device_config"])
        if backup.get("policies"):
            await self.command(screen_id, "set_device_owner_policies", backup["policies"])
        return pushed

    async def clone_screen(self, source_id: str, target_id: str, options: dict[str, Any]) -> dict[str, Any]:
        if source_id == target_id:
            raise vol.Invalid("Source and target screens must be different")
        source = _latest_project(self, source_id)
        if not source:
            raise vol.Invalid("Source screen has no stored project")
        target = _latest_project(self, target_id) or deepcopy(source)
        out = deepcopy(source)
        src_panel = out.setdefault("panel", {})
        target_panel = target.get("panel", {}) if isinstance(target.get("panel"), dict) else {}
        # Identity and remote enrollment are always target-specific.
        if "remoteSync" in target_panel:
            src_panel["remoteSync"] = deepcopy(target_panel["remoteSync"])
        if target_panel.get("panelName"):
            src_panel["panelName"] = target_panel["panelName"]

        if not options.get("dashboard_layout", True):
            out["dashboards"] = deepcopy(target.get("dashboards", []))
        if not options.get("theme", True):
            out["customThemes"] = deepcopy(target.get("customThemes", []))
            for key in ("appThemeId", "appThemeUpdatedAtEpochMs"):
                if key in target_panel:
                    src_panel[key] = deepcopy(target_panel[key])
        if not options.get("kiosk", True):
            for key in (
                "kioskEnabled", "forceFullScreen", "showNavigation", "showTopBar", "showFloatingUiHandle",
                "floatingButtonOpacity", "showInRecents", "installerUnlockTimeoutMinutes", "pinProtection",
                "floatingButton", "navigation", "topBar",
            ):
                if key in target_panel:
                    src_panel[key] = deepcopy(target_panel[key])
        if not options.get("scaling", True) and "screenScale" in target_panel:
            src_panel["screenScale"] = deepcopy(target_panel["screenScale"])

        item = await self.push(target_id, out, note=f"Clone from {source_id}")
        source_screen = self._screen(source_id)
        if options.get("device_settings", True):
            cfg = _dict_from_jsonish(source_screen.get("device_config_json"))
            if cfg:
                await self.command(target_id, "restore_device_config", cfg)
        if options.get("device_policies", True):
            await self.command(
                target_id,
                "set_device_owner_policies",
                {
                    "auto_apply": bool(source_screen.get("policy_auto_apply", False)),
                    "protect_uninstall": bool(source_screen.get("uninstall_blocked", False)),
                    "persistent_home": bool(source_screen.get("default_launcher", False)),
                    "disable_keyguard": bool(source_screen.get("policy_disable_keyguard", False)),
                    "block_safe_boot": bool(source_screen.get("block_safe_boot", False)),
                    "block_add_user": bool(source_screen.get("block_add_user", False)),
                    "block_factory_reset": bool(source_screen.get("block_factory_reset", False)),
                },
            )
        return item

    async def apply_profile(self, screen_id: str, profile_id: str) -> dict[str, Any]:
        profile = self.data["profiles"].get(profile_id)
        if not profile:
            raise vol.Invalid("Screen profile was not found")
        project = _latest_project(self, screen_id)
        if not project:
            raise vol.Invalid("Screen has no project to apply a profile to")
        project.setdefault("panel", {})["screenScale"] = deepcopy(profile["screen_scale"])
        return await self.push(screen_id, project, note=f"Apply screen profile: {profile['name']}")

    async def begin_update_upload(self, filename: str, version_name: str, version_code: int) -> dict[str, Any]:
        upload_id = uuid.uuid4().hex
        update_id = f"{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:8]}"
        path = self.upload_dir / f"{upload_id}.part"
        await self.hass.async_add_executor_job(path.write_bytes, b"")
        self.upload_sessions[upload_id] = {
            "upload_id": upload_id,
            "update_id": update_id,
            "filename": _safe_filename(filename, "stips-panel.apk"),
            "version_name": version_name.strip(),
            "version_code": int(version_code),
            "path": str(path),
            "bytes": 0,
            "created": _utcnow(),
        }
        return {"upload_id": upload_id, "update_id": update_id, "chunk_size": 384 * 1024}

    async def append_update_chunk(self, upload_id: str, encoded: str) -> int:
        session = self.upload_sessions.get(upload_id)
        if not session:
            raise vol.Invalid("Upload session not found")
        try:
            chunk = base64.b64decode(encoded, validate=True)
        except Exception as err:
            raise vol.Invalid("Invalid base64 APK chunk") from err
        if len(chunk) > MAX_UPLOAD_CHUNK_BYTES:
            raise vol.Invalid("APK chunk is too large")
        if int(session.get("bytes", 0)) + len(chunk) > MAX_APK_BYTES:
            raise vol.Invalid("APK upload exceeds 250 MB limit")
        path = Path(session["path"])

        def append() -> None:
            with path.open("ab") as handle:
                handle.write(chunk)

        await self.hass.async_add_executor_job(append)
        session["bytes"] = int(session.get("bytes", 0)) + len(chunk)
        return session["bytes"]

    async def finish_update_upload(self, upload_id: str, expected_size: int = 0) -> dict[str, Any]:
        session = self.upload_sessions.pop(upload_id, None)
        if not session:
            raise vol.Invalid("Upload session not found")
        source = Path(session["path"])
        size = source.stat().st_size
        if expected_size and size != int(expected_size):
            source.unlink(missing_ok=True)
            raise vol.Invalid(f"APK size mismatch: received {size}, expected {expected_size}")
        if size < 1024:
            source.unlink(missing_ok=True)
            raise vol.Invalid("Uploaded APK is unexpectedly small")

        def digest_file() -> str:
            digest = hashlib.sha256()
            with source.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            return digest.hexdigest()

        sha256 = await self.hass.async_add_executor_job(digest_file)
        update_id = session["update_id"]
        target = self.update_dir / f"{update_id}.apk"
        await self.hass.async_add_executor_job(source.replace, target)
        item = {
            "update_id": update_id,
            "filename": session["filename"],
            "version_name": session["version_name"],
            "version_code": int(session["version_code"]),
            "size_bytes": size,
            "sha256": sha256,
            "created": _utcnow(),
            "path": str(target),
        }
        self.data["updates"][update_id] = item
        self.data["updates"]["latest"] = deepcopy(item)
        for screen in self.data["screens"].values():
            screen["available_version"] = item["version_name"]
            screen["update_available"] = bool(item["version_name"] != screen.get("app_version"))
        await self.save()
        return {k: v for k, v in item.items() if k != "path"}

    async def install_update(self, screen_ids: list[str], force: bool = False) -> int:
        latest = self.data["updates"].get("latest")
        if not isinstance(latest, dict):
            raise vol.Invalid("No APK has been uploaded")
        payload = {k: deepcopy(v) for k, v in latest.items() if k != "path"}
        payload["force"] = bool(force)
        sent = 0
        for screen_id in screen_ids:
            if screen_id in self.data["screens"]:
                screen = self.data["screens"][screen_id]
                screen["desired_update_id"] = latest["update_id"]
                screen["desired_update_force"] = bool(force)
                await self.command(screen_id, "install_update", payload)
                sent += 1
        return sent

    def fleet_summary(self) -> dict[str, Any]:
        screens = list(self.data["screens"].values())
        latest = self.data["updates"].get("latest")
        latest_version = latest.get("version_name", "") if isinstance(latest, dict) else ""
        if not latest_version:
            counts: dict[str, int] = {}
            for screen in screens:
                version = str(screen.get("app_version") or "")
                if version:
                    counts[version] = counts.get(version, 0) + 1
            latest_version = max(counts, key=counts.get) if counts else ""
        online = sum(1 for x in screens if _is_screen_online(x))
        owner = sum(1 for x in screens if bool(x.get("device_owner")))
        current = sum(1 for x in screens if latest_version and x.get("app_version") == latest_version)
        pending = sum(1 for x in screens if latest_version and x.get("app_version") != latest_version)
        problems = sum(
            1
            for x in screens
            if not _is_screen_online(x)
            or bool(x.get("last_error"))
            or str(x.get("health_state", "ready")) not in {
                "ready", "healthy", "idle", "starting", "provisioning", "maintenance", "disabled", ""
            }
        )
        return {
            "screens": len(screens),
            "online": online,
            "device_owner": owner,
            "current_version": current,
            "latest_version": latest_version,
            "updates_pending": pending,
            "problems": problems,
        }


class UpdateDownloadView(HomeAssistantView):
    """Authenticated APK download endpoint consumed by Device Owner STIPS clients."""

    url = "/api/stips_panel/update/{update_id}"
    name = "api:stips_panel:update"
    requires_auth = True

    def __init__(self, manager: StipsPanelManager) -> None:
        self.manager = manager

    async def get(self, request: web.Request, update_id: str) -> web.StreamResponse:
        item = self.manager.data["updates"].get(update_id)
        if not isinstance(item, dict):
            raise web.HTTPNotFound()
        path = Path(item.get("path", ""))
        if not path.is_file() or path.parent != self.manager.update_dir:
            raise web.HTTPNotFound()
        return web.FileResponse(
            path=path,
            headers={
                "Content-Disposition": f'attachment; filename="{_safe_filename(item.get("filename", ""), "stips-panel.apk")}"',
                "X-STIPS-SHA256": str(item.get("sha256", "")),
            },
        )


async def _async_setup_manager(hass: HomeAssistant) -> bool:
    """Set up the manager once for either YAML or a config entry."""
    if DOMAIN in hass.data:
        return True

    manager = StipsPanelManager(hass)
    await manager.load()
    hass.data[DOMAIN] = manager

    hass.services.async_register(DOMAIN, "register_screen", manager.register_screen, schema=REGISTER_SCHEMA)
    hass.services.async_register(DOMAIN, "report_status", manager.report_status, schema=REPORT_SCHEMA)
    hass.services.async_register(DOMAIN, "report_command", manager.report_command, schema=REPORT_COMMAND_SCHEMA)
    hass.services.async_register(DOMAIN, "report_update", manager.report_update, schema=REPORT_UPDATE_SCHEMA)
    hass.services.async_register(DOMAIN, "report_diagnostics", manager.report_diagnostics, schema=REPORT_DIAGNOSTICS_SCHEMA)
    hass.services.async_register(DOMAIN, "sync_current", manager.sync_current, schema=SYNC_CURRENT_SCHEMA)
    hass.services.async_register(DOMAIN, "request_recovery", manager.request_recovery, schema=RECOVERY_SCHEMA)

    async def _admin_push(call: ServiceCall) -> None:
        await manager.push(call.data["screen_id"], call.data["project"], call.data.get("note", ""))

    async def _admin_rollback(call: ServiceCall) -> None:
        await manager.rollback(call.data["screen_id"], int(call.data["revision"]))

    async def _admin_command(call: ServiceCall) -> None:
        await manager.command(call.data["screen_id"], call.data["command"], call.data.get("data", {}))

    async_register_admin_service(hass, DOMAIN, "push_dashboard", _admin_push, PUSH_SCHEMA)
    async_register_admin_service(hass, DOMAIN, "rollback", _admin_rollback, ROLLBACK_SCHEMA)
    async_register_admin_service(hass, DOMAIN, "screen_command", _admin_command, COMMAND_SCHEMA)

    for command in (
        ws_list_screens,
        ws_get_screen,
        ws_push_dashboard,
        ws_rollback,
        ws_list_templates,
        ws_save_template,
        ws_delete_template,
        ws_push_template,
        ws_screen_command,
        ws_bulk_command,
        ws_list_groups,
        ws_save_group,
        ws_delete_group,
        ws_create_backup,
        ws_list_backups,
        ws_restore_backup,
        ws_clone_screen,
        ws_list_profiles,
        ws_apply_profile,
        ws_update_upload_begin,
        ws_update_upload_chunk,
        ws_update_upload_finish,
        ws_install_update,
        ws_get_diagnostics_package,
        ws_provisioning_info,
    ):
        websocket_api.async_register_command(hass, command)

    hass.http.register_view(UpdateDownloadView(manager))
    frontend_path = Path(__file__).parent / "frontend"
    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(
                "/stips-panel/static",
                str(frontend_path),
                cache_headers=True,
            )
        ]
    )
    if not frontend.async_panel_exists(hass, "stips-panels"):
        frontend.async_register_built_in_panel(
            hass,
            component_name="custom",
            sidebar_title="STIPS Panels",
            sidebar_icon="mdi:view-dashboard-edit",
            frontend_url_path="stips-panels",
            config={
                "_panel_custom": {
                    "name": "stips-panel-editor",
                    "embed_iframe": False,
                    "trust_external": False,
                    "js_url": "/stips-panel/static/stips-panel-editor.js?v=1.5.8",
                }
            },
            require_admin=True,
        )
    for screen_id in manager.data["screens"]:
        manager._publish_screen_states(screen_id)
    return True


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up legacy YAML configuration when present."""
    if DOMAIN not in config:
        return True
    return await _async_setup_manager(hass)


async def async_setup_entry(hass: HomeAssistant, _entry: ConfigEntry) -> bool:
    """Set up STIPS Panel from the Home Assistant integrations UI."""
    return await _async_setup_manager(hass)


def _manager(hass: HomeAssistant) -> StipsPanelManager:
    return hass.data[DOMAIN]


@websocket_api.websocket_command({vol.Required("type"): "stips_panel/list_screens"})
@websocket_api.require_admin
@callback
def ws_list_screens(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    manager = _manager(hass)
    screens = []
    for screen_id, value in manager.data["screens"].items():
        item = _screen_with_connectivity(value)
        desired = manager.data["desired"].get(screen_id)
        item["desired_revision"] = int(desired["revision"]) if desired else 0
        screens.append(item)
    latest = manager.data["updates"].get("latest")
    connection.send_result(
        msg["id"],
        {
            "screens": sorted(screens, key=lambda x: x.get("screen_name", "")),
            "summary": manager.fleet_summary(),
            "latest_update": ({k: v for k, v in latest.items() if k != "path"} if isinstance(latest, dict) else None),
        },
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "stips_panel/get_screen", vol.Required("screen_id"): SCREEN_ID}
)
@websocket_api.require_admin
@callback
def ws_get_screen(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    manager = _manager(hass)
    screen_id = msg["screen_id"]
    connection.send_result(
        msg["id"],
        {
            "screen": (
                _screen_with_connectivity(manager.data["screens"][screen_id])
                if screen_id in manager.data["screens"]
                else None
            ),
            "desired": deepcopy(manager.data["desired"].get(screen_id)),
            "revisions": [
                {k: deepcopy(v) for k, v in rev.items() if k != "project"}
                for rev in reversed(manager.data["revisions"].get(screen_id, []))
            ],
            "backups": [
                {k: deepcopy(v) for k, v in item.items() if k not in {"project", "device_config", "policies"}}
                for item in reversed(manager.data["backups"].get(screen_id, []))
            ],
            "latest_diagnostic": {
                k: v for k, v in manager.data["diagnostics"].get(screen_id, {}).items() if k != "path"
            },
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "stips_panel/push_dashboard",
        vol.Required("screen_id"): SCREEN_ID,
        vol.Required("project"): dict,
        vol.Optional("note", default=""): str,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_push_dashboard(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    item = await _manager(hass).push(msg["screen_id"], msg["project"], msg.get("note", ""))
    connection.send_result(msg["id"], {"revision": item["revision"], "created": item["created"]})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "stips_panel/rollback",
        vol.Required("screen_id"): SCREEN_ID,
        vol.Required("revision"): vol.Coerce(int),
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_rollback(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    item = await _manager(hass).rollback(msg["screen_id"], int(msg["revision"]))
    connection.send_result(msg["id"], {"revision": item["revision"], "created": item["created"]})


@websocket_api.websocket_command({vol.Required("type"): "stips_panel/list_templates"})
@websocket_api.require_admin
@callback
def ws_list_templates(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    templates = [
        {k: deepcopy(v) for k, v in item.items() if k != "project"}
        for item in _manager(hass).data["templates"].values()
    ]
    connection.send_result(msg["id"], {"templates": sorted(templates, key=lambda x: x.get("name", ""))})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "stips_panel/save_template",
        vol.Required("template_id"): str,
        vol.Required("name"): str,
        vol.Required("project"): dict,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_save_template(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    item = await _manager(hass).save_template(msg["template_id"], msg["name"], msg["project"])
    connection.send_result(msg["id"], {k: v for k, v in item.items() if k != "project"})


@websocket_api.websocket_command(
    {vol.Required("type"): "stips_panel/delete_template", vol.Required("template_id"): str}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_delete_template(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    await _manager(hass).delete_template(msg["template_id"])
    connection.send_result(msg["id"], {"deleted": msg["template_id"]})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "stips_panel/push_template",
        vol.Required("screen_id"): SCREEN_ID,
        vol.Required("template_id"): str,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_push_template(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    manager = _manager(hass)
    template = manager.data["templates"].get(msg["template_id"])
    if template is None:
        connection.send_error(msg["id"], "template_not_found", "Shared dashboard was not found")
        return
    manager._screen(msg["screen_id"])["assignment_template_id"] = msg["template_id"]
    item = await manager.push(msg["screen_id"], template["project"], note=f"Shared: {template['name']}")
    connection.send_result(msg["id"], {"revision": item["revision"]})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "stips_panel/screen_command",
        vol.Required("screen_id"): SCREEN_ID,
        vol.Required("command"): vol.In(COMMANDS),
        vol.Optional("data", default={}): dict,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_screen_command(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    await _manager(hass).command(msg["screen_id"], msg["command"], msg.get("data", {}))
    connection.send_result(msg["id"], {"sent": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "stips_panel/bulk_command",
        vol.Required("screen_ids"): [SCREEN_ID],
        vol.Required("command"): vol.In(COMMANDS),
        vol.Optional("data", default={}): dict,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_bulk_command(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    manager = _manager(hass)
    sent = 0
    for screen_id in dict.fromkeys(msg["screen_ids"]):
        if screen_id in manager.data["screens"]:
            await manager.command(screen_id, msg["command"], msg.get("data", {}))
            sent += 1
    connection.send_result(msg["id"], {"sent": sent})


@websocket_api.websocket_command({vol.Required("type"): "stips_panel/list_groups"})
@websocket_api.require_admin
@callback
def ws_list_groups(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    connection.send_result(msg["id"], {"groups": list(_manager(hass).data["groups"].values())})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "stips_panel/save_group",
        vol.Required("group_id"): str,
        vol.Required("name"): str,
        vol.Required("screen_ids"): [SCREEN_ID],
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_save_group(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    manager = _manager(hass)
    item = {
        "group_id": _safe_filename(msg["group_id"], uuid.uuid4().hex[:8]),
        "name": msg["name"].strip() or "STIPS group",
        "screen_ids": list(dict.fromkeys(msg["screen_ids"])),
        "updated": _utcnow(),
    }
    manager.data["groups"][item["group_id"]] = item
    await manager.save()
    connection.send_result(msg["id"], item)


@websocket_api.websocket_command(
    {vol.Required("type"): "stips_panel/delete_group", vol.Required("group_id"): str}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_delete_group(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    manager = _manager(hass)
    manager.data["groups"].pop(msg["group_id"], None)
    await manager.save()
    connection.send_result(msg["id"], {"deleted": msg["group_id"]})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "stips_panel/create_backup",
        vol.Required("screen_id"): SCREEN_ID,
        vol.Optional("label", default="Manual backup"): str,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_create_backup(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    item = await _manager(hass).create_backup(msg["screen_id"], msg.get("label", "Manual backup"))
    connection.send_result(msg["id"], {k: v for k, v in item.items() if k not in {"project", "device_config", "policies"}})


@websocket_api.websocket_command(
    {vol.Required("type"): "stips_panel/list_backups", vol.Required("screen_id"): SCREEN_ID}
)
@websocket_api.require_admin
@callback
def ws_list_backups(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    items = [
        {k: deepcopy(v) for k, v in item.items() if k not in {"project", "device_config", "policies"}}
        for item in reversed(_manager(hass).data["backups"].get(msg["screen_id"], []))
    ]
    connection.send_result(msg["id"], {"backups": items})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "stips_panel/restore_backup",
        vol.Required("screen_id"): SCREEN_ID,
        vol.Required("backup_id"): str,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_restore_backup(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    item = await _manager(hass).restore_backup(msg["screen_id"], msg["backup_id"])
    connection.send_result(msg["id"], {"revision": item["revision"]})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "stips_panel/clone_screen",
        vol.Required("source_screen_id"): SCREEN_ID,
        vol.Required("target_screen_id"): SCREEN_ID,
        vol.Optional("options", default={}): dict,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_clone_screen(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    item = await _manager(hass).clone_screen(
        msg["source_screen_id"], msg["target_screen_id"], msg.get("options", {})
    )
    connection.send_result(msg["id"], {"revision": item["revision"]})


@websocket_api.websocket_command({vol.Required("type"): "stips_panel/list_profiles"})
@websocket_api.require_admin
@callback
def ws_list_profiles(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    connection.send_result(msg["id"], {"profiles": list(_manager(hass).data["profiles"].values())})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "stips_panel/apply_profile",
        vol.Required("screen_id"): SCREEN_ID,
        vol.Required("profile_id"): str,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_apply_profile(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    item = await _manager(hass).apply_profile(msg["screen_id"], msg["profile_id"])
    connection.send_result(msg["id"], {"revision": item["revision"]})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "stips_panel/update_upload_begin",
        vol.Required("filename"): str,
        vol.Required("version_name"): str,
        vol.Required("version_code"): vol.Coerce(int),
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_update_upload_begin(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    item = await _manager(hass).begin_update_upload(msg["filename"], msg["version_name"], int(msg["version_code"]))
    connection.send_result(msg["id"], item)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "stips_panel/update_upload_chunk",
        vol.Required("upload_id"): str,
        vol.Required("content_base64"): str,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_update_upload_chunk(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    received = await _manager(hass).append_update_chunk(msg["upload_id"], msg["content_base64"])
    connection.send_result(msg["id"], {"received_bytes": received})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "stips_panel/update_upload_finish",
        vol.Required("upload_id"): str,
        vol.Optional("expected_size", default=0): vol.Coerce(int),
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_update_upload_finish(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    item = await _manager(hass).finish_update_upload(msg["upload_id"], int(msg.get("expected_size", 0)))
    connection.send_result(msg["id"], item)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "stips_panel/install_update",
        vol.Required("screen_ids"): [SCREEN_ID],
        vol.Optional("force", default=False): bool,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_install_update(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    sent = await _manager(hass).install_update(list(dict.fromkeys(msg["screen_ids"])), bool(msg.get("force", False)))
    connection.send_result(msg["id"], {"sent": sent})


@websocket_api.websocket_command(
    {vol.Required("type"): "stips_panel/get_diagnostics_package", vol.Required("screen_id"): SCREEN_ID}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_get_diagnostics_package(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    item = _manager(hass).data["diagnostics"].get(msg["screen_id"])
    if not isinstance(item, dict):
        connection.send_error(msg["id"], "not_found", "No diagnostic package has been uploaded for this screen")
        return
    path = Path(item.get("path", ""))
    if not path.is_file():
        connection.send_error(msg["id"], "not_found", "Diagnostic package file is missing")
        return
    raw = await hass.async_add_executor_job(path.read_bytes)
    connection.send_result(
        msg["id"],
        {
            "filename": item.get("filename", "stips-diagnostics.zip"),
            "size_bytes": len(raw),
            "sha256": item.get("sha256", ""),
            "created": item.get("created", ""),
            "content_base64": base64.b64encode(raw).decode("ascii"),
        },
    )


@websocket_api.websocket_command({vol.Required("type"): "stips_panel/provisioning_info"})
@websocket_api.require_admin
@callback
def ws_provisioning_info(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    latest = _manager(hass).data["updates"].get("latest")
    connection.send_result(
        msg["id"],
        {
            "device_admin_component": "tech.stips.home/tech.stips.home.kiosk.StipsDeviceAdminReceiver",
            "adb_device_owner_command": (
                "adb shell dpm set-device-owner "
                "tech.stips.home/tech.stips.home.kiosk.StipsDeviceAdminReceiver"
            ),
            "latest_apk": ({k: v for k, v in latest.items() if k != "path"} if isinstance(latest, dict) else None),
            "managed_provisioning_note": (
                "For zero-touch/QR Device Owner provisioning, Android must provision STIPS during initial device setup. "
                "The APK download location and Android package checksum/signature data must be supplied by the deployment environment."
            ),
        },
    )
