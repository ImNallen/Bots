import json
import os
import select
import signal
import sys
import time

SLOT = int(sys.argv[1])
if SLOT < 1 or SLOT > 8:
    sys.exit(2)
DISPLAY = f":{SLOT}"
BUS = f"/run/computerd-bus-{SLOT}/bus"
os.environ["DISPLAY"] = DISPLAY
os.environ["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={BUS}"
# computerd ends this process at its own deadline. This alarm also ends it when computerd dies first.
signal.alarm(30)

from PIL import ImageGrab  # noqa: E402

STATES = ["focused", "focusable", "checked", "pressed", "selected", "expanded", "enabled", "active", "modal", "editable"]
VALUE_ROLES = {"entry", "text", "combo box", "spin button", "slider"}
MAX_DEPTH = 60
MAX_VISITS = 30000
CALL_TIMEOUT_MS = 1500

frame = None


# Cuts by UTF-16 units, because computerd's schema counts those, and a capture over a limit fails to parse.
def cap(text, limit):
    text = " ".join((text or "").split())
    while len(text.encode("utf-16-le")) // 2 > limit:
        text = text[:-1]
    return text


def grab():
    return ImageGrab.grab(xdisplay=DISPLAY)


def capture(request):
    global frame
    tree = walk_in_child(request) if os.path.exists(BUS) else {"bus": "missing"}
    frame = grab()
    width, height = frame.size
    return {"capture": {"width": width, "height": height, "apps": [], "windows": [], "nodes": [], **tree}}


# libatspi aborts its process when it cannot reach the accessibility bus, and a frozen app can stall a call, so the walk runs in a
# child that this process can lose.
def walk_in_child(request):
    read_end, write_end = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(read_end)
        signal.alarm(25)
        try:
            tree = {"bus": "ok", "apps": [], "windows": [], "nodes": []}
            walk_desktop(tree, set(request["roles"]), request["maxNodes"], request["appDeadlineMs"] / 1000)
            data = json.dumps(tree, separators=(",", ":")).encode()
        except BaseException:
            data = b'{"bus":"failed"}'
        with os.fdopen(write_end, "wb") as out:
            out.write(data)
        os._exit(0)
    os.close(write_end)
    deadline = time.monotonic() + request["walkDeadlineMs"] / 1000
    chunks = []
    with os.fdopen(read_end, "rb", buffering=0) as source:
        while True:
            left = deadline - time.monotonic()
            if left <= 0 or not select.select([source], [], [], left)[0]:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
                return {"bus": "failed"}
            chunk = source.read(65536)
            if not chunk:
                break
            chunks.append(chunk)
    os.waitpid(pid, 0)
    try:
        return json.loads(b"".join(chunks))
    except ValueError:
        return {"bus": "failed"}


def walk_desktop(tree, roles, max_nodes, app_deadline):
    import gi

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi, Gio, GLib

    # The display can hold the address of a launcher from a bus that restarted, so ask this bus for its own.
    flags = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
    session = Gio.DBusConnection.new_for_address_sync(f"unix:path={BUS}", flags, None, None)
    reply = session.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus", "GetAddress", None, GLib.VariantType("(s)"), Gio.DBusCallFlags.NONE, CALL_TIMEOUT_MS, None)
    os.environ["AT_SPI_BUS_ADDRESS"] = reply.unpack()[0]
    Atspi.init()
    Atspi.set_timeout(CALL_TIMEOUT_MS, CALL_TIMEOUT_MS)
    state_types = {name: getattr(Atspi.StateType, name.upper()) for name in STATES}
    showing = Atspi.StateType.SHOWING
    visible = Atspi.StateType.VISIBLE

    def box_of(node):
        rect = Atspi.Component.get_extents(node, Atspi.CoordType.SCREEN)
        return {"x": rect.x, "y": rect.y, "w": rect.width, "h": rect.height}

    def value_of(node, role):
        if role not in VALUE_ROLES:
            return None
        interfaces = node.get_interfaces()
        if "Text" in interfaces:
            count = Atspi.Text.get_character_count(node)
            return cap(Atspi.Text.get_text(node, 0, min(count, 200)), 100)
        if "Value" in interfaces:
            return cap(f"{Atspi.Value.get_current_value(node):g}", 100)
        return None

    desktop = Atspi.get_desktop(0)
    for app_index in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(app_index)
        if app is None:
            continue
        deadline = time.monotonic() + app_deadline
        name = cap(app.get_name(), 40)
        entry = {"app": name, "pid": max(app.get_process_id(), 1), "silent": False}
        tree["apps"].append(entry)
        visits = 0
        try:
            for window_index in range(app.get_child_count()):
                window = app.get_child_at_index(window_index)
                if window is None:
                    continue
                states = window.get_state_set()
                if not (states.contains(showing) and states.contains(visible)):
                    continue
                win = len(tree["windows"])
                tree["windows"].append(
                    {
                        "win": win,
                        "app": name,
                        "pid": entry["pid"],
                        "role": cap(window.get_role_name(), 32),
                        "title": cap(window.get_name(), 120),
                        "box": box_of(window),
                        "active": states.contains(state_types["active"]),
                        "modal": states.contains(state_types["modal"]),
                    }
                )
                stack = [(window.get_child_at_index(i), 1) for i in reversed(range(window.get_child_count()))]
                while stack:
                    if time.monotonic() > deadline:
                        raise TimeoutError
                    node, depth = stack.pop()
                    visits += 1
                    if node is None or depth > MAX_DEPTH or visits > MAX_VISITS:
                        continue
                    node_states = node.get_state_set()
                    if not (node_states.contains(showing) and node_states.contains(visible)):
                        continue
                    role = node.get_role_name()
                    focusable = node_states.contains(state_types["focusable"])
                    if (role in roles or focusable) and len(tree["nodes"]) < max_nodes:
                        tree["nodes"].append(
                            {
                                "win": win,
                                "role": cap(role, 32),
                                "name": cap(node.get_name(), 120),
                                "value": value_of(node, role),
                                "states": [label for label, state in state_types.items() if node_states.contains(state)],
                                "focusable": focusable,
                                "box": box_of(node),
                            }
                        )
                    count = node.get_child_count()
                    stack.extend((node.get_child_at_index(i), depth + 1) for i in reversed(range(count)))
        except Exception:
            entry["silent"] = True


VERBS = {"capture": capture}


def main():
    for line in sys.stdin:
        try:
            request = json.loads(line)
            reply = {"ok": True, **VERBS[request["verb"]](request)}
        except Exception as error:
            reply = {"ok": False, "error": f"{type(error).__name__}: {error}"[:300]}
        sys.stdout.write(json.dumps(reply, separators=(",", ":")) + "\n")
        sys.stdout.flush()


main()
