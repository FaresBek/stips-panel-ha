"""Config flow for STIPS Panel Remote Manager."""
from __future__ import annotations

from typing import Any

from homeassistant import config_entries
from .const import DOMAIN


class StipsPanelConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Create the single local STIPS Panel manager entry."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ):
        """Confirm local manager setup."""
        if user_input is not None:
            return self.async_create_entry(
                title="STIPS Panel Remote Manager",
                data={},
            )

        return self.async_show_form(step_id="user")
