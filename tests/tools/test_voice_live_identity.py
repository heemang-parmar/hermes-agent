"""GPT-Live speaks as the profile it dials.

A Bot chat runs its live voice session on the Bot's own profile; the voice layer must
introduce itself by that profile's name, not as "Hermes", while the Bot's agent answers.
"""

from hermes_constants import get_hermes_home
from tools import voice_live


def _write_profile_meta(text: str) -> None:
    (get_hermes_home() / "profile.yaml").write_text(text, encoding="utf-8")


def test_named_profile_voice_uses_its_name_and_role():
    _write_profile_meta("display_name: Ayan\ndescription: 1Labs AI Business Lead.\n")

    instructions = voice_live.build_session_config()["instructions"]

    assert instructions.startswith("You are Ayan,")
    assert "Your role: 1Labs AI Business Lead." in instructions
    assert "You are Hermes" not in instructions


def test_bot_title_names_the_voice_when_no_display_name():
    _write_profile_meta("ui_meta:\n  hermes-bots:\n    title: Kyrah\n")

    assert voice_live.live_instructions({}).startswith("You are Kyrah,")


def test_unnamed_profile_stays_hermes_and_keeps_extra_instructions():
    instructions = voice_live.live_instructions({"instructions": "Prefer short answers."})

    assert instructions.startswith("You are Hermes,")
    assert instructions.endswith("\n\nPrefer short answers.")
