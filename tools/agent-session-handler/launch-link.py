import hashlib
import hmac
import os
import re
import stat
import sys
import tempfile
import time

# Launch links (agent-session://launch?...): every value is already URL-decoded.
#   launch-link.py validate <session> <cwd> <title> <prompt>
#       prints the reason the link must be refused, and nothing when it is acceptable
#   launch-link.py verify <session> <exp> <cwd> <title> <prompt> <sig>
#       prints signed, unsigned, expired or no-key
#   launch-link.py write-prompt <prompt>
#       writes the prompt to a new private file and prints its path
#   launch-link.py build-command <session> <cwd> <title> <prompt file>
#       prints the command to type, from ~/.config/agent-session/launch-command or the default
# AGENT_SESSION_CONFIG_DIR overrides ~/.config/agent-session, for tests.

UUID = re.compile(r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$")
CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
PROMPT_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
# The code points the handler treats as invisible, as inclusive ranges, fixed to Unicode 18.0.0
# whichever Python runs: the union of the Default_Ignorable_Code_Point set in
# DerivedCoreProperties.txt and the Cf, Zl and Zp characters in extracted/DerivedGeneralCategory.txt.
INVISIBLE_RANGES = (
    (0x00AD, 0x00AD),
    (0x034F, 0x034F),
    (0x0600, 0x0605),
    (0x061C, 0x061C),
    (0x06DD, 0x06DD),
    (0x070F, 0x070F),
    (0x0890, 0x0891),
    (0x08E2, 0x08E2),
    (0x115F, 0x1160),
    (0x17B4, 0x17B5),
    (0x180B, 0x180F),
    (0x200B, 0x200F),
    (0x2028, 0x202E),
    (0x2060, 0x206F),
    (0x3164, 0x3164),
    (0xFE00, 0xFE0F),
    (0xFEFF, 0xFEFF),
    (0xFFA0, 0xFFA0),
    (0xFFF0, 0xFFFB),
    (0x110BD, 0x110BD),
    (0x110CD, 0x110CD),
    (0x13430, 0x1343F),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0000, 0xE0FFF),
)
# The zero-width joiner and the two presentation selectors, which the title and prompt may still hold
# so that joined and presentation-styled emoji work. Flags built from tag characters (England,
# Scotland, Wales) stay refused.
TEXT_ALLOWED_INVISIBLES = frozenset(("\u200d", "\ufe0e", "\ufe0f"))
KEY = re.compile(r"^[0-9a-f]{64}$")
EXPIRY = re.compile(r"^[0-9]{1,12}$")
PLACEHOLDER = re.compile(r"\{(cwd|session|title|name|prompt)\}")
SIGNATURE_CONTEXT = "agent-session-launch-v1"
MAX_PROMPT_BYTES = 32 * 1024
MAX_TITLE_CHARS = 200
MAX_FRESH_SECONDS = 150
PROMPT_FILE_MAX_AGE_SECONDS = 24 * 60 * 60
DEFAULT_TEMPLATE = (
    "cd {cwd} && AGENT_SESSION_LAUNCH={session} AGENT_SESSION_TITLE={title} "
    "claude --session-id {session} {name} -- {prompt}"
)


def main() -> None:
    subcommands = {
        "validate": (validate, 4),
        "verify": (verify, 6),
        "write-prompt": (write_prompt, 1),
        "build-command": (build_command, 4),
    }

    name = sys.argv[1] if len(sys.argv) > 1 else ""
    args = sys.argv[2:]
    if name not in subcommands or len(args) != subcommands[name][1]:
        raise SystemExit("usage: launch-link.py validate|verify|write-prompt|build-command <values>")

    result = subcommands[name][0](*args)
    if result:
        print(result)


def validate(session: str, cwd: str, title: str, prompt: str) -> str:
    for label, value in (("session id", session), ("directory", cwd), ("title", title)):
        if CONTROL.search(value):
            return f"the {label} contains a control character"

    if PROMPT_CONTROL.search(prompt):
        return "the prompt contains a control character other than tab or newline"

    for label, value, allow_text_invisibles in (
        ("session id", session, False),
        ("directory", cwd, False),
        ("title", title, True),
        ("prompt", prompt, True),
    ):
        hidden = invisible_character(value, allow_text_invisibles)
        if hidden:
            return f"the {label} contains an invisible character (U+{ord(hidden):04X})"

    if not UUID.match(session):
        return "the session id is not a UUID"

    if not (os.path.isabs(cwd) and os.path.isdir(cwd)):
        return "the directory is not an existing absolute path"

    if len(title) > MAX_TITLE_CHARS:
        return f"the title is longer than {MAX_TITLE_CHARS} characters"

    if not prompt.strip():
        return "the link has no prompt"

    if len(prompt.encode("utf-8", "surrogateescape")) > MAX_PROMPT_BYTES:
        return "the prompt is longer than 32 KiB"

    return ""


def verify(session: str, exp: str, cwd: str, title: str, prompt: str, sig: str) -> str:
    key = read_key()
    if key is None:
        return "no-key"

    canonical = "\n".join((SIGNATURE_CONTEXT, session, exp, cwd, title, prompt))
    expected = hmac.new(key, canonical.encode("utf-8", "surrogateescape"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected.encode("ascii"), sig.encode("utf-8", "surrogateescape")):
        return "unsigned"

    if not EXPIRY.match(exp):
        return "expired"

    remaining = int(exp) - time.time()
    if remaining < 0 or remaining > MAX_FRESH_SECONDS:
        return "expired"

    return "signed"


def write_prompt(prompt: str) -> str:
    folder = os.path.join(tempfile.gettempdir(), "agent-session")
    try:
        os.mkdir(folder, 0o700)
    except FileExistsError:
        pass

    info = os.lstat(folder)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise SystemExit(f"{folder} is not a private directory owned by this user")

    prune_prompt_files(folder)
    handle, path = tempfile.mkstemp(prefix="prompt-", suffix=".txt", dir=folder)
    with os.fdopen(handle, "w", encoding="utf-8", errors="surrogateescape") as prompt_file:
        prompt_file.write(prompt)

    return path


def build_command(session: str, cwd: str, title: str, prompt_file: str) -> str:
    values = {
        "cwd": shell_quote(cwd),
        "session": shell_quote(session),
        "title": shell_quote(title),
        "name": f"-n {shell_quote(title)}" if title else "",
        "prompt": f'"$(cat {shell_quote(prompt_file)} && rm -f {shell_quote(prompt_file)})"',
    }
    return PLACEHOLDER.sub(lambda match: values[match.group(1)], read_template())


def invisible_character(value: str, allow_text_invisibles: bool) -> str:
    for character in value:
        if allow_text_invisibles and character in TEXT_ALLOWED_INVISIBLES:
            continue

        code_point = ord(character)
        for first, last in INVISIBLE_RANGES:
            if first <= code_point <= last:
                return character

    return ""


# The launch key's 32 bytes, or None when the file cannot be read, is not a regular file owned by this
# user with no group or other permission bits, or does not hold 64 lowercase hex digits.
def read_key():
    try:
        with open(os.path.join(config_dir(), "launch-key"), encoding="ascii") as key_file:
            info = os.fstat(key_file.fileno())
            text = key_file.read().strip()
    except (OSError, UnicodeDecodeError):
        return None

    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        return None

    if not KEY.match(text):
        return None

    return bytes.fromhex(text)


def prune_prompt_files(folder: str) -> None:
    cutoff = time.time() - PROMPT_FILE_MAX_AGE_SECONDS
    for name in os.listdir(folder):
        path = os.path.join(folder, name)
        try:
            if name.startswith("prompt-") and os.lstat(path).st_mtime < cutoff:
                os.unlink(path)
        except OSError:
            pass


# The first line of the launch-command file with carriage returns removed, or the default when the
# file is missing, unreadable or blank.
def read_template() -> str:
    try:
        with open(os.path.join(config_dir(), "launch-command"), encoding="utf-8") as template_file:
            first_line = template_file.readline().rstrip("\n").replace("\r", "")
    except (OSError, UnicodeDecodeError):
        return DEFAULT_TEMPLATE
    return first_line if first_line.strip() else DEFAULT_TEMPLATE


def config_dir() -> str:
    return os.environ.get("AGENT_SESSION_CONFIG_DIR") or os.path.join(
        os.path.expanduser("~"), ".config", "agent-session"
    )


# The value in single quotes, the way AppleScript's `quoted form of` writes it.
def shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


main()
