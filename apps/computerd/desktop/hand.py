import base64
import io
import json
import os
import select
import signal
import subprocess
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

from PIL import ImageChops, ImageDraw, ImageFont, ImageGrab  # noqa: E402

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
    return {"capture": {"width": width, "height": height, "apps": [], "windows": [], "nodes": [], "menus": [], **tree}}


# libatspi aborts its process when it cannot reach the accessibility bus, and a frozen app can stall a call, so the walk runs in a
# child that this process can lose.
def walk_in_child(request):
    read_end, write_end = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(read_end)
        signal.alarm(25)
        try:
            tree = {"bus": "ok", "apps": [], "windows": [], "nodes": [], "menus": []}
            walk_desktop(tree, set(request["roles"]), request["maxNodes"], request["appDeadlineMs"] / 1000)
            tree["menus"] = [menu if menu["box"] is not None else {"win": menu["win"], "box": {"x": 0, "y": 0, "w": 0, "h": 0}} for menu in tree["menus"]]
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


def union(a, b):
    if a is None:
        return dict(b)
    left, top = min(a["x"], b["x"]), min(a["y"], b["y"])
    right, bottom = max(a["x"] + a["w"], b["x"] + b["w"]), max(a["y"] + a["h"], b["y"] + b["h"])
    return {"x": left, "y": top, "w": right - left, "h": bottom - top}


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
                        "path": cap(window.path or "", 96),
                        "role": cap(window.get_role_name(), 32),
                        "title": cap(window.get_name(), 120),
                        "box": box_of(window),
                        "active": states.contains(state_types["active"]),
                        "modal": states.contains(state_types["modal"]),
                    }
                )
                stack = [(window.get_child_at_index(i), 1, None) for i in reversed(range(window.get_child_count()))]
                while stack:
                    if time.monotonic() > deadline:
                        raise TimeoutError
                    node, depth, menu = stack.pop()
                    visits += 1
                    if node is None or depth > MAX_DEPTH or visits > MAX_VISITS:
                        continue
                    node_states = node.get_state_set()
                    if not (node_states.contains(showing) and node_states.contains(visible)):
                        continue
                    role = node.get_role_name()
                    focusable = node_states.contains(state_types["focusable"])
                    if (role in roles or focusable) and len(tree["nodes"]) < max_nodes:
                        box = box_of(node)
                        tree["nodes"].append(
                            {
                                "win": win,
                                "role": cap(role, 32),
                                "name": cap(node.get_name(), 120),
                                "value": value_of(node, role),
                                "states": [label for label, state in state_types.items() if node_states.contains(state)],
                                "focusable": focusable,
                                "box": box,
                                "menu": menu,
                            }
                        )
                        if menu is not None and box["w"] > 0 and box["h"] > 0:
                            tree["menus"][menu]["box"] = union(tree["menus"][menu]["box"], box)
                    inner = menu
                    if role == "menu":
                        # A GTK menu opens inside its own window, over the rest of it. Its items are the only part that shows, so their
                        # union is where the open menu covers that window.
                        inner = len(tree["menus"])
                        tree["menus"].append({"win": win, "box": None})
                    count = node.get_child_count()
                    stack.extend((node.get_child_at_index(i), depth + 1, inner) for i in reversed(range(count)))
        except Exception:
            entry["silent"] = True


typing = None


# sudo passes computerd's SIGTERM on to this process, and a cancel must also stop typing that is under way.
def stop(signum, frame_):
    if typing is not None and typing.poll() is None:
        typing.kill()
    os._exit(128 + signum)


signal.signal(signal.SIGTERM, stop)


def xdotool(*args):
    global typing
    typing = subprocess.Popen(["xdotool", *args], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if typing.wait(timeout=25) != 0:
        raise RuntimeError(f"xdotool {args[0]} failed")


def send_input(request):
    for step in request["steps"]:
        kind = step["kind"]
        if kind == "move":
            xdotool("mousemove", "--sync", str(step["x"]), str(step["y"]))
        elif kind == "click":
            xdotool("click", "--repeat", str(step["count"]), "--delay", "80", str(step["button"]))
        elif kind == "wheel":
            xdotool("click", "--repeat", str(step["count"]), "--delay", "40", str(step["button"]))
        elif kind == "key":
            xdotool("key", "--clearmodifiers", "--repeat", str(step["times"]), "--delay", "60", step["combo"])
        elif kind == "type":
            xdotool("type", "--clearmodifiers", "--delay", "12", "--", step["text"])
        else:
            raise ValueError(f"unknown step {kind}")
    return {}


def changed_share(a, b):
    unchanged = ImageChops.difference(a, b).convert("L").histogram()[0]
    return 1 - unchanged / (a.size[0] * a.size[1])


def settle(request):
    started = time.monotonic()
    time.sleep(request["minMs"] / 1000)
    previous = grab()
    while (time.monotonic() - started) * 1000 < request["maxMs"]:
        time.sleep(request["quietMs"] / 1000)
        current = grab()
        if changed_share(previous, current) < 0.002:
            break
        previous = current
    return {}


COLORS = [(214, 39, 40), (31, 119, 180), (44, 160, 44), (148, 103, 189), (255, 127, 14), (23, 190, 207), (227, 119, 194)]


def overlaps(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def render(request):
    if frame is None:
        raise ValueError("render before capture")
    image = frame.convert("RGB")
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 13)
    except OSError:
        font = ImageFont.load_default()
    placed = []
    for index, item in enumerate(request["boxes"]):
        box = item["box"]
        color = COLORS[index % len(COLORS)]
        left, top, right, bottom = box["x"], box["y"], box["x"] + box["w"] - 1, box["y"] + box["h"] - 1
        draw.rectangle((left, top, right, bottom), outline=color, width=2)
        text = str(item["mark"])
        _, _, text_w, text_h = draw.textbbox((0, 0), text, font=font)
        w, h = text_w + 6, text_h + 4
        for x, y in ((left, top - h), (left, top), (right - w + 1, bottom + 1), (right - w + 1, bottom - h + 1)):
            x = min(max(x, 0), image.size[0] - w)
            y = min(max(y, 0), image.size[1] - h)
            label = (x, y, x + w, y + h)
            if not any(overlaps(label, other) for other in placed):
                placed.append(label)
                draw.rectangle(label, fill=color)
                draw.text((x + 3, y + 1), text, fill=(255, 255, 255), font=font)
                break
    return {"image": encode(image, request["maxBytes"])}


def encode(image, max_bytes):
    attempts = [("image/png", lambda out: image.save(out, "PNG"))]
    attempts += [("image/jpeg", lambda out, q=q: image.save(out, "JPEG", quality=q)) for q in (80, 65, 50)]
    for media_type, save in attempts:
        out = io.BytesIO()
        save(out)
        if out.tell() <= max_bytes:
            return {"mediaType": media_type, "base64": base64.b64encode(out.getvalue()).decode("ascii")}
    return None


VERBS = {"capture": capture, "render": render, "input": send_input, "settle": settle}


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
