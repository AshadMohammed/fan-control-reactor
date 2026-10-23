#!/usr/bin/python3
"""
reactord — Reactor fan-control daemon.

Runs as root under launchd, reads temperatures from `macmon pipe` and drives
the two fans through the `smcfan` helper. Serves the panel UI and a small JSON
API on 127.0.0.1.

Only the Python standard library is used, so /usr/bin/python3 is enough.

Safety rule #1: whenever this process stops — SIGTERM, SIGINT, Ctrl-C, a
crash, a normal return — it puts the fans back under macOS control with
`smcfan auto`.
"""

import argparse
import atexit
import json
import math
import os
import signal
import subprocess
import sys
import threading
import time
import traceback
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse, parse_qs
import mimetypes

# --------------------------------------------------------------------------
# constants
# --------------------------------------------------------------------------

DEFAULT_STATE_DIR = "/Library/Application Support/Reactor"
DEFAULT_SMCFAN = os.path.join(DEFAULT_STATE_DIR, "smcfan")
DEFAULT_MACMON = "/opt/homebrew/bin/macmon"
DEFAULT_UI = os.path.join(DEFAULT_STATE_DIR, "ui")
DEFAULT_PORT = 7979
LOG_PATH = "/Library/Logs/Reactor.log"

HISTORY_SECONDS = 600
EVENT_LIMIT = 80

ALARM_CODES = [
    "CORE_WARM",
    "CORE_HOT",
    "INTERLOCK",
    "PUMP_STALL",
    "SENSOR_FAIL",
    "MANUAL_OVERRIDE",
    "SCRAM",
]

FAN_NAMES = ["Pump A", "Pump B", "Pump C", "Pump D"]

TEMP_INTERLOCK_ON = 95.0
TEMP_INTERLOCK_OFF = 85.0
TEMP_CORE_WARM = 80.0
TEMP_CORE_HOT = 92.0
CURVE_HYSTERESIS = 3.0
SENSOR_TIMEOUT = 10.0
SENSOR_FRESH = 3.0
STALL_SECONDS = 10.0
SET_MIN_DELTA = 150

DEFAULT_CONFIG = {
    "mode": "curve",
    "curve": {"start_c": 50, "full_c": 80},
    "manual_pct": 60,
}


def clamp(value, low, high):
    return max(low, min(high, value))


def log_stamp(ts=None):
    if ts is None:
        ts = time.time()
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts))


def round_int(value):
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return 0


# --------------------------------------------------------------------------
# event log
# --------------------------------------------------------------------------


class EventLog(object):
    """Last 80 events in memory, appended to /Library/Logs/Reactor.log."""

    def __init__(self, path):
        self.path = path
        self.events = deque(maxlen=EVENT_LIMIT)
        self.lock = threading.Lock()
        self.fh = None
        try:
            directory = os.path.dirname(path)
            if directory and not os.path.isdir(directory):
                os.makedirs(directory)
            self.fh = open(path, "a", encoding="utf-8", buffering=1)
        except OSError as exc:
            sys.stderr.write("reactord: cannot open %s (%s); logging to stderr\n"
                             % (path, exc))
            self.fh = None

    def add(self, level, msg):
        ts = time.time()
        event = {"ts": int(ts), "level": level, "msg": msg}
        line = "%s [%s] %s\n" % (log_stamp(ts), level.upper(), msg)
        with self.lock:
            self.events.append(event)
            if self.fh is not None:
                try:
                    self.fh.write(line)
                    self.fh.flush()
                except OSError:
                    pass
            else:
                sys.stderr.write(line)

    def snapshot(self):
        with self.lock:
            return [dict(e) for e in self.events]

    def close(self):
        with self.lock:
            if self.fh is not None:
                try:
                    self.fh.close()
                except OSError:
                    pass
                self.fh = None


# --------------------------------------------------------------------------
# config
# --------------------------------------------------------------------------


def normalize_config(raw):
    cfg = {
        "mode": "curve",
        "curve": {"start_c": 50, "full_c": 80},
        "manual_pct": 60,
    }
    if isinstance(raw, dict):
        mode = raw.get("mode")
        if mode in ("auto", "curve", "manual", "scram"):
            cfg["mode"] = mode
        curve = raw.get("curve")
        if isinstance(curve, dict):
            try:
                start = float(curve.get("start_c", 50))
                full = float(curve.get("full_c", 80))
            except (TypeError, ValueError):
                start, full = 50.0, 80.0
            start = clamp(start, 40.0, 85.0)
            full = clamp(full, start + 5.0, 95.0)
            cfg["curve"] = {"start_c": int(round(start)), "full_c": int(round(full))}
        try:
            pct = float(raw.get("manual_pct", 60))
        except (TypeError, ValueError):
            pct = 60.0
        cfg["manual_pct"] = int(round(clamp(pct, 0.0, 100.0)))
    return cfg


def load_config(state_dir):
    path = os.path.join(state_dir, "config.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return normalize_config(json.load(fh))
    except (OSError, ValueError):
        return normalize_config(None)


def save_config(state_dir, cfg):
    path = os.path.join(state_dir, "config.json")
    tmp = path + ".tmp"
    try:
        if not os.path.isdir(state_dir):
            os.makedirs(state_dir)
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        try:
            os.chmod(path, 0o644)
        except OSError:
            pass
        return True
    except OSError as exc:
        sys.stderr.write("reactord: cannot save config %s (%s)\n" % (path, exc))
        return False


# --------------------------------------------------------------------------
# alarms
# --------------------------------------------------------------------------


class Alarms(object):
    def __init__(self, events):
        self.events = events
        self.lock = threading.Lock()
        self.items = {}
        for code in ALARM_CODES:
            self.items[code] = {
                "code": code,
                "active": False,
                "since": None,
                "acked": True,
            }

    def set(self, code, active, on_msg=None, off_msg=None, level="alarm"):
        """Raises/clears one alarm, logging only on a real transition."""
        with self.lock:
            item = self.items[code]
            was = item["active"]
            if active and not was:
                item["active"] = True
                item["since"] = int(time.time())
                item["acked"] = False
                if on_msg:
                    self.events.add(level, on_msg)
            elif not active and was:
                item["active"] = False
                item["since"] = None
                item["acked"] = True
                if off_msg:
                    self.events.add("info", off_msg)
            elif active and item["since"] is None:
                item["since"] = int(time.time())

    def ack(self):
        count = 0
        with self.lock:
            for item in self.items.values():
                if item["active"] and not item["acked"]:
                    item["acked"] = True
                    count += 1
        if count:
            self.events.add("info", "Alarms acknowledged")
        return count

    def snapshot(self):
        with self.lock:
            return [dict(self.items[c]) for c in ALARM_CODES]


# --------------------------------------------------------------------------
# daemon
# --------------------------------------------------------------------------


class Reactor(object):
    def __init__(self, args):
        self.args = args
        self.smcfan_path = args.smcfan
        self.macmon_path = args.macmon
        self.ui_dir = os.path.abspath(args.ui) if args.ui else ""
        self.state_dir = args.state_dir
        self.port = args.port
        self.dry_run = args.dry_run
        self.log_path = args.log_file

        self.events = EventLog(self.log_path)
        self.alarms = Alarms(self.events)
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.released = False
        self.release_lock = threading.Lock()

        self.cfg = load_config(self.state_dir)

        # latest macmon sample
        self.sample_ts = 0.0
        self.cpu_c = 0.0
        self.gpu_c = 0.0
        self.temp_c = 0.0
        self.cpu_w = 0.0
        self.chip_w = 0.0
        self.cpu_load = 0.0
        self.macmon_rpms = {}

        # fans as seen from the SMC
        self.fans = []
        self.last_fan_read = 0.0
        self.last_fan_error = 0.0

        self.history = deque(maxlen=HISTORY_SECONDS)
        self.procs = []
        self.last_proc_scan = 0.0

        self.system_control = True
        self.interlock = False
        self.curve_manual = False
        self.force_apply = True
        self.sensor_fail = False
        self.started_at = time.time()
        self.last_apply = 0.0
        self.last_sent = {}
        self.last_logged = {}
        self.stall_since = {}
        self.last_error_note = {}

        self.macmon_proc = None
        self.macmon_thread = None
        self.http = None
        self.http_thread = None

    # -- logging helpers ---------------------------------------------------

    def note_error(self, key, msg):
        """Rate-limit repeated failure messages to one per 30 s."""
        ts = time.time()
        if ts - self.last_error_note.get(key, 0.0) >= 30.0:
            self.last_error_note[key] = ts
            self.events.add("warn", msg)

    def log(self, level, msg):
        self.events.add(level, msg)

    # -- subprocess helpers ------------------------------------------------

    def _run(self, argv, timeout=5.0):
        """Run a command, never raise. Returns (ok, stdout, stderr)."""
        try:
            proc = subprocess.run(
                argv,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
            )
            out = proc.stdout.decode("utf-8", "replace")
            err = proc.stderr.decode("utf-8", "replace")
            return proc.returncode == 0, out, err
        except FileNotFoundError:
            return False, "", "%s not found" % argv[0]
        except subprocess.TimeoutExpired:
            return False, "", "%s timed out" % argv[0]
        except OSError as exc:
            return False, "", str(exc)

    def smc(self, *args):
        argv = [self.smcfan_path] + [str(a) for a in args]
        if self.dry_run and args and args[0] in ("set", "max", "auto"):
            self.events.add("info", "[dry-run] would run: " + " ".join(argv))
            return True
        ok, out, err = self._run(argv, timeout=6.0)
        if not ok:
            detail = (err or out or "unknown error").strip().splitlines()
            message = detail[-1] if detail else "unknown error"
            self.note_error("smc:" + str(args[0]), "smcfan %s failed: %s"
                            % (args[0], message))
        return ok

    def read_fans(self):
        ok, out, err = self._run([self.smcfan_path, "read"], timeout=6.0)
        if not ok:
            self.note_error("smc-read", "could not read fans from the SMC")
            return False
        try:
            data = json.loads(out)
            fans = data.get("fans") or []
        except ValueError:
            self.note_error("smc-read-json", "smcfan read returned unreadable data")
            return False

        result = []
        for entry in fans:
            try:
                fid = int(entry.get("id"))
            except (TypeError, ValueError):
                continue
            result.append({
                "id": fid,
                "name": FAN_NAMES[fid] if fid < len(FAN_NAMES) else "Pump %d" % (fid + 1),
                "rpm": round_int(entry.get("rpm")),
                "min": round_int(entry.get("min")),
                "max": round_int(entry.get("max")),
                "target": round_int(entry.get("target")),
            })
        if not result:
            self.note_error("smc-empty", "the SMC reported no fans")
            return False

        with self.lock:
            self.fans = result
            self.last_fan_read = time.time()
            # After sleep/wake the SMC can drop back to auto on its own; re-send next tick.
            if not self.system_control and any(
                    int(entry.get("mode") or 0) == 0 for entry in fans):
                self.force_apply = True
        return True

    # -- safety release ----------------------------------------------------

    def release(self, reason="shutdown"):
        """Hand the fans back to macOS. Safe to call many times."""
        with self.release_lock:
            if self.released:
                return
            self.released = True
        self.smc("auto")
        self.events.add("info", "Fans handed back to macOS")
        sys.stderr.write("reactord: fans released (%s)\n" % reason)

    # -- macmon ------------------------------------------------------------

    def macmon_loop(self):
        while not self.stop.is_set():
            try:
                proc = subprocess.Popen(
                    [self.macmon_path, "pipe", "-i", "1000"],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    bufsize=1,
                    universal_newlines=True,
                )
            except (OSError, ValueError) as exc:
                self.note_error("macmon-start", "cannot start macmon: %s" % exc)
                if self.stop.wait(2.0):
                    break
                continue

            self.macmon_proc = proc
            try:
                for line in proc.stdout:
                    if self.stop.is_set():
                        break
                    self.handle_macmon_line(line)
            except (OSError, ValueError):
                pass
            finally:
                try:
                    proc.stdout.close()
                except (OSError, ValueError):
                    pass
            try:
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                proc.kill()
                try:
                    proc.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    pass
            self.macmon_proc = None
            if self.stop.is_set():
                break
            self.events.add("warn", "macmon stopped; restarting it")
            if self.stop.wait(1.0):
                break

    def handle_macmon_line(self, line):
        line = line.strip()
        if not line.startswith("{"):
            return
        try:
            sample = json.loads(line)
        except ValueError:
            return
        if not isinstance(sample, dict):
            return

        temp = sample.get("temp") or {}
        cpu_c = temp.get("cpu_temp_avg")
        gpu_c = temp.get("gpu_temp_avg")
        try:
            cpu_c = float(cpu_c)
            gpu_c = float(gpu_c)
        except (TypeError, ValueError):
            return

        try:
            cpu_w = float(sample.get("cpu_power") or 0.0)
        except (TypeError, ValueError):
            cpu_w = 0.0
        try:
            chip_w = float(sample.get("all_power") or sample.get("sys_power") or 0.0)
        except (TypeError, ValueError):
            chip_w = 0.0
        try:
            load = float(sample.get("cpu_usage_pct") or 0.0)
        except (TypeError, ValueError):
            load = 0.0
        load = clamp(load, 0.0, 1.0)

        rpms = {}
        for fan in sample.get("fans") or []:
            if not isinstance(fan, dict):
                continue
            name = str(fan.get("name", ""))
            try:
                index = int(name.replace("fan", ""))
            except (TypeError, ValueError):
                continue
            try:
                rpms[index] = round_int(fan.get("rpm"))
            except (TypeError, ValueError):
                pass

        with self.lock:
            self.sample_ts = time.time()
            self.cpu_c = cpu_c
            self.gpu_c = gpu_c
            self.temp_c = max(cpu_c, gpu_c)
            self.cpu_w = cpu_w
            self.chip_w = chip_w
            self.cpu_load = load
            self.macmon_rpms = rpms

    def start_macmon(self):
        self.macmon_thread = threading.Thread(
            target=self.macmon_loop, name="macmon", daemon=True)
        self.macmon_thread.start()

    # -- control -----------------------------------------------------------

    def control_loop(self):
        while not self.stop.is_set():
            started = time.time()
            try:
                self.tick(started)
            except Exception:
                sys.stderr.write("reactord: control loop error:\n")
                traceback.print_exc()
                self.events.add("alarm", "Internal error in the control loop")
            self.stop.wait(max(0.2, 1.0 - (time.time() - started)))

    def tick(self, ts):
        # Subprocess calls (smcfan) must happen outside self.lock so the HTTP
        # thread can always take a snapshot.
        if ts - self.last_proc_scan >= 3.0:
            self.last_proc_scan = ts
            ok, out, _err = self._run(["/bin/ps", "-Ao", "pcpu=,comm="], timeout=3.0)
            if ok:
                grouped = {}
                for line in out.splitlines():
                    fields = line.strip().split(None, 1)
                    if len(fields) != 2:
                        continue
                    try:
                        cpu_pct = float(fields[0])
                    except ValueError:
                        continue
                    path = fields[1].strip()
                    if os.path.basename(path) == "ps":
                        continue
                    app_path = path.split(".app/", 1)[0]
                    if app_path != path:
                        name = os.path.basename(app_path)
                    else:
                        name = os.path.basename(path)
                    if not name:
                        continue
                    entry = grouped.setdefault(name, {"name": name, "cpu_pct": 0.0, "count": 0})
                    entry["cpu_pct"] += cpu_pct
                    entry["count"] += 1
                procs = sorted(grouped.values(), key=lambda item: item["cpu_pct"], reverse=True)[:6]
                for item in procs:
                    item["cpu_pct"] = round(item["cpu_pct"], 1)
                with self.lock:
                    self.procs = procs

        if ts - self.last_fan_read >= 2.0:
            self.refresh_fans(ts)

        with self.lock:
            sample_age = ts - self.sample_ts if self.sample_ts else None
            has_sample = self.sample_ts > 0 and sample_age is not None
            fresh = has_sample and sample_age <= SENSOR_FRESH
            temp = self.temp_c if has_sample else None
            mode = self.cfg["mode"]

            # --- sensor watchdog ---
            if fresh and self.sensor_fail:
                self.sensor_fail = False
                self.events.add("info", "Sensor data is back")
            stale_for = sample_age if sample_age is not None else ts - self.started_at
            if stale_for > SENSOR_TIMEOUT and not self.sensor_fail:
                self.sensor_fail = True
                self.events.add(
                    "alarm",
                    "No sensor data for 10 s — fans back on system control")

            # --- interlock (hysteresis) ---
            if temp is not None:
                if temp >= TEMP_INTERLOCK_ON and not self.interlock:
                    self.interlock = True
                    self.force_apply = True
                elif temp < TEMP_INTERLOCK_OFF and self.interlock:
                    self.interlock = False
                    self.force_apply = True

            interlock = self.interlock
            sensor_fail = self.sensor_fail
            # Without real min/max a curve or manual speed would collapse to the floor.
            fans_known = bool(self.fans) and all(
                (fan.get("max") or 0) > 0 for fan in self.fans)
            cfg = {"mode": mode,
                   "curve": dict(self.cfg["curve"]),
                   "manual_pct": int(self.cfg["manual_pct"])}

        self.update_temperature_alarms(temp)
        self.update_fan_alarms(ts)
        self.update_mode_alarms()

        # --- decide and apply ---
        if interlock:
            self.apply_targets(self.max_targets(), reason="interlock")
        elif sensor_fail or not has_sample:
            self.apply_system(reason="sensors")
        elif not fans_known and cfg["mode"] in ("curve", "manual"):
            self.apply_system(reason="fan limits unknown")
        elif cfg["mode"] == "auto":
            self.apply_system(reason="mode auto")
        elif cfg["mode"] == "scram":
            self.apply_targets(self.max_targets(), reason="scram")
        elif cfg["mode"] == "manual":
            self.apply_targets(self.manual_targets(), reason="manual")
        else:
            self.apply_curve(temp, cfg["curve"])

        self.record_history(ts, temp)

    def refresh_fans(self, ts):
        if self.read_fans():
            return
        # fall back to the fan speeds macmon reports
        with self.lock:
            if self.macmon_rpms:
                for fid, rpm in sorted(self.macmon_rpms.items()):
                    found = None
                    for fan in self.fans:
                        if fan["id"] == fid:
                            found = fan
                            break
                    if found is None:
                        found = {
                            "id": fid,
                            "name": FAN_NAMES[fid] if fid < len(FAN_NAMES)
                                    else "Pump %d" % (fid + 1),
                            "rpm": rpm,
                            "min": 0,
                            "max": 0,
                            "target": rpm,
                        }
                        self.fans.append(found)
                    else:
                        found["rpm"] = rpm
            self.last_fan_read = ts

    def update_temperature_alarms(self, temp):
        if temp is None:
            return
        self.alarms.set(
            "CORE_WARM", temp >= TEMP_CORE_WARM,
            "Core warm: %.0f °C" % temp,
            "Core back below 80 °C", level="warn")
        self.alarms.set(
            "CORE_HOT", temp >= TEMP_CORE_HOT,
            "Core HOT: %.0f °C" % temp,
            "Core back below 92 °C", level="alarm")

    def update_fan_alarms(self, ts):
        with self.lock:
            manual_mode = self.cfg["mode"] == "manual"
            stalled = False
            for fan in self.fans:
                # Prefer what we asked for; the SMC read-back is only a fallback.
                target = self.last_sent.get(fan["id"], fan.get("target") or 0)
                rpm = fan.get("rpm") or 0
                if manual_mode and target > 0 and rpm <= 0:
                    started = self.stall_since.get(fan["id"])
                    if started is None:
                        self.stall_since[fan["id"]] = ts
                    elif ts - started > STALL_SECONDS:
                        stalled = True
                else:
                    self.stall_since.pop(fan["id"], None)
        self.alarms.set(
            "PUMP_STALL", stalled,
            "Pump stall: a fan is not turning",
            "Pump turning again")

    def update_mode_alarms(self):
        mode = self.cfg["mode"]
        self.alarms.set(
            "MANUAL_OVERRIDE", mode == "manual",
            "Manual override: fans are running at a fixed setting",
            "Manual override released", level="warn")
        self.alarms.set(
            "SCRAM", mode == "scram",
            "SCRAM: all fans forced to maximum",
            "SCRAM cancelled")
        self.alarms.set(
            "INTERLOCK", self.interlock,
            "Safety interlock: all fans forced to maximum",
            "Safety interlock released")
        self.alarms.set(
            "SENSOR_FAIL", self.sensor_fail,
            "Sensor failure: no temperature data",
            "Sensor failure cleared")

    def max_targets(self):
        targets = {}
        with self.lock:
            for fan in self.fans:
                # Unknown max: ask for far too much and let smcfan clamp to the real max.
                targets[fan["id"]] = fan.get("max") or 100000
        return targets

    def manual_targets(self):
        pct = clamp(float(self.cfg["manual_pct"]), 0.0, 100.0)
        targets = {}
        with self.lock:
            for fan in self.fans:
                low = float(fan.get("min") or 0)
                high = float(fan.get("max") or 0)
                targets[fan["id"]] = low + (pct / 100.0) * (high - low)
        return targets

    def curve_targets(self, temp, curve=None):
        if curve is None:
            with self.lock:
                curve = dict(self.cfg["curve"])
        start = float(curve["start_c"])
        full = float(curve["full_c"])
        span = full - start
        pct = 0.0 if span <= 0 else clamp((temp - start) / span, 0.0, 1.0)
        targets = {}
        with self.lock:
            for fan in self.fans:
                low = float(fan.get("min") or 0)
                high = float(fan.get("max") or 0)
                targets[fan["id"]] = low + pct * (high - low)
        return targets

    def apply_curve(self, temp, curve=None):
        if curve is None:
            with self.lock:
                curve = dict(self.cfg["curve"])
        start = float(curve["start_c"])
        if self.curve_manual:
            if temp < start - CURVE_HYSTERESIS:
                self.curve_manual = False
                self.force_apply = True
                self.log("info", "Cooled below %.0f °C — fans back to macOS control"
                         % (start - CURVE_HYSTERESIS))
                self.apply_system(reason="curve idle")
                return
            if temp < start:
                # inside the hysteresis band: hold manual at the floor speed
                pass
        else:
            if temp >= start:
                self.curve_manual = True
                self.force_apply = True
                self.log("info", "Curve engaged at %.1f °C — taking manual control"
                         % temp)

        if self.curve_manual:
            self.apply_targets(self.curve_targets(temp, curve), reason="curve")
        else:
            self.apply_system(reason="curve idle")

    def apply_system(self, reason="system"):
        with self.lock:
            if self.system_control:
                return
        ok = self.smc("auto")
        if not ok and not self.dry_run:
            return
        with self.lock:
            self.system_control = True
            self.force_apply = False
            self.last_sent = {}
            self.stall_since = {}
            if reason == "curve idle":
                self.curve_manual = False
        self.log("info", "Fans on system control")

    def apply_targets(self, targets, reason="manual"):
        if not targets:
            return
        ts = time.time()
        with self.lock:
            was_manual = not self.system_control
            force = self.force_apply or not was_manual
            if ts - self.last_apply < 1.0:
                return
            self.last_apply = ts
            self.force_apply = False
            self.system_control = False

            sends = []
            for fid in sorted(targets):
                target = round_int(targets[fid])
                previous = self.last_sent.get(fid)
                if force or previous is None or abs(target - previous) > SET_MIN_DELTA:
                    sends.append((fid, target))
            self.last_sent = dict((fid, round_int(targets[fid])) for fid in targets)

            fans = list(self.fans)

        if not sends:
            return
        names = dict((fan["id"], fan["name"]) for fan in fans)
        failed = []
        for fid, target in sends:
            if not self.smc("set", fid, target):
                failed.append(fid)
                continue
            with self.lock:
                previous_logged = self.last_logged.get(fid)
                quiet = (previous_logged is not None and
                         abs(target - previous_logged) < 250)
                if not quiet:
                    self.last_logged[fid] = target
            if quiet:
                continue
            name = names.get(fid, "Fan %d" % (fid + 1))
            verb = "ramped to"
            if previous_logged is not None and target < previous_logged:
                verb = "eased to"
            self.log("info", "%s %s %s rpm" % (name, verb, format(target, ",")))
        if failed:
            # Try again next second instead of waiting for a 50 rpm move.
            with self.lock:
                for fid in failed:
                    self.last_sent.pop(fid, None)
        with self.lock:
            for fan in self.fans:
                if fan["id"] in targets:
                    fan["target"] = round_int(targets[fan["id"]])

    def record_history(self, ts, temp):
        with self.lock:
            rpms = {}
            for fan in self.fans:
                rpms[fan["id"]] = fan.get("rpm") or 0
            row = [
                int(ts),
                round(temp if temp is not None else (self.temp_c or 0.0), 1),
                rpms.get(0, 0),
                rpms.get(1, 0),
                round(self.chip_w or 0.0, 1),
            ]
            self.history.append(row)

    # -- state snapshot ----------------------------------------------------

    def snapshot(self, since=None):
        with self.lock:
            mode = self.cfg["mode"]
            fans = [dict(f) for f in self.fans]
            if not self.system_control:
                for fan in fans:
                    if fan["id"] in self.last_sent:
                        fan["target"] = round_int(self.last_sent[fan["id"]])
            history = list(self.history)
            state = {
                "ok": True,
                "error": None,
                "ts": int(time.time()),
                "mode": mode,
                "temp_c": round(self.temp_c, 1) if self.sample_ts else 0,
                "cpu_c": round(self.cpu_c, 1) if self.sample_ts else 0,
                "gpu_c": round(self.gpu_c, 1) if self.sample_ts else 0,
                "cpu_w": round(self.cpu_w, 1) if self.sample_ts else 0,
                "chip_w": round(self.chip_w, 1) if self.sample_ts else 0,
                "cpu_load": round(self.cpu_load, 3),
                "interlock": bool(self.interlock),
                "system_control": bool(self.system_control),
                "fans": fans,
                "curve": dict(self.cfg["curve"]),
                "manual_pct": int(self.cfg["manual_pct"]),
                "alarms": self.alarms.snapshot(),
                "history": history,
                "events": self.events.snapshot(),
                "procs": [dict(p) for p in self.procs],
                "cores": os.cpu_count(),
            }
            if not fans:
                state["fans"] = [
                    {"id": 0, "name": "Pump A", "rpm": 0, "min": 0, "max": 0,
                     "target": 0},
                    {"id": 1, "name": "Pump B", "rpm": 0, "min": 0, "max": 0,
                     "target": 0},
                ]
        if since is not None:
            state["history"] = [row for row in state["history"] if row[0] > since]
        return state

    # -- API actions -------------------------------------------------------

    def set_mode(self, mode):
        if mode not in ("auto", "curve", "manual", "scram"):
            return False, "mode must be auto, curve, manual or scram"
        with self.lock:
            changed = mode != self.cfg["mode"]
            self.cfg["mode"] = mode
            self.curve_manual = False
            self.force_apply = True
        if changed:
            self.log("info", "Mode changed to %s" % mode)
        save_config(self.state_dir, self.cfg)
        return True, None

    def set_curve(self, start_c, full_c):
        try:
            start = float(start_c)
            full = float(full_c)
        except (TypeError, ValueError):
            return False, "start_c and full_c must be numbers"
        if not (math.isfinite(start) and math.isfinite(full)):
            return False, "start_c and full_c must be numbers"
        if start < 40 or start > 85:
            return False, "start_c must be between 40 and 85"
        if full < start + 5 or full > 95:
            return False, "full_c must be at least start_c + 5 and at most 95"
        with self.lock:
            self.cfg["curve"] = {"start_c": int(round(start)),
                                 "full_c": int(round(full))}
            self.force_apply = True
        self.log("info", "Curve set to start %.0f °C, full %.0f °C" % (start, full))
        save_config(self.state_dir, self.cfg)
        return True, None

    def set_manual_pct(self, pct):
        try:
            value = float(pct)
        except (TypeError, ValueError):
            return False, "pct must be a number"
        if not math.isfinite(value):
            return False, "pct must be a number"
        if value < 0 or value > 100:
            return False, "pct must be between 0 and 100"
        with self.lock:
            self.cfg["manual_pct"] = int(round(value))
            if self.cfg["mode"] == "manual":
                self.force_apply = True
        self.log("info", "Manual speed set to %d%%" % int(round(value)))
        save_config(self.state_dir, self.cfg)
        return True, None

    # -- lifecycle ---------------------------------------------------------

    def start(self):
        self.events.add("info", "Reactor daemon starting")
        self.started_at = time.time()
        self.sensor_fail = False
        self.smc("auto")
        self.released = False
        self.read_fans()
        self.events.add("info", "Fans on system control")

        self.http = ReactorHTTPServer(("127.0.0.1", self.port), Handler, self)
        self.http.daemon_threads = True
        self.http_thread = threading.Thread(
            target=self.http.serve_forever, name="http", daemon=True)
        self.http_thread.start()

        self.start_macmon()
        self.control_loop()

    def shutdown(self):
        self.stop.set()
        try:
            proc = self.macmon_proc
            if proc is not None:
                proc.terminate()
                try:
                    proc.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    proc.kill()
        except (OSError, ValueError):
            pass
        if self.http is not None:
            try:
                self.http.shutdown()
            except Exception:
                pass
            try:
                self.http.server_close()
            except Exception:
                pass
        self.release("shutdown")
        self.events.close()


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------


class ReactorHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address, handler, reactor):
        self.reactor = reactor
        ThreadingHTTPServer.__init__(self, address, handler)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Reactor/1.0"
    sys_version = ""

    # -- plumbing ----------------------------------------------------------

    def log_message(self, fmt, *args):
        pass  # keep the launchd log for real events

    @property
    def reactor(self):
        return self.server.reactor

    def host_ok(self):
        host = (self.headers.get("Host") or "").strip().lower()
        port = self.reactor.port
        return host in ("127.0.0.1:%d" % port, "localhost:%d" % port)

    def send_json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, code, message):
        self.close_connection = True
        body = json.dumps({"ok": False, "error": message}).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def read_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            return None, "bad Content-Length"
        if length < 0 or length > 65536:
            return None, "body too large"
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}, None
        try:
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None, "body must be valid JSON"
        if not isinstance(data, dict):
            return None, "body must be a JSON object"
        return data, None

    # -- GET ---------------------------------------------------------------

    def do_GET(self):
        if not self.host_ok():
            self.send_error_json(403, "bad Host header")
            return

        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path == "/api/state":
            since = None
            query = parse_qs(parsed.query)
            if "since" in query:
                try:
                    since = float(query["since"][0])
                except (TypeError, ValueError):
                    since = None
            self.send_json(200, self.reactor.snapshot(since))
            return

        if path.startswith("/api/"):
            self.send_error_json(404, "unknown endpoint")
            return

        self.serve_static(path)

    def serve_static(self, path):
        ui_dir = self.reactor.ui_dir
        if not ui_dir or not os.path.isdir(ui_dir):
            self.send_error_json(404, "UI folder is not installed")
            return

        rel = path.lstrip("/")
        if rel == "":
            rel = "index.html"
        parts = [p for p in rel.split("/") if p not in ("", ".")]
        if not parts or any(p == ".." or "\\" in p for p in parts):
            self.send_error_json(404, "not found")
            return

        root = os.path.realpath(ui_dir)
        full = os.path.realpath(os.path.join(root, *parts))
        if full != root and not full.startswith(root + os.sep):
            self.send_error_json(404, "not found")
            return
        if not os.path.isfile(full):
            self.send_error_json(404, "not found")
            return

        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in (
                "application/javascript", "application/json",
                "image/svg+xml"):
            ctype += "; charset=utf-8"
        try:
            with open(full, "rb") as fh:
                body = fh.read()
        except OSError:
            self.send_error_json(404, "not found")
            return

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # -- POST --------------------------------------------------------------

    def do_POST(self):
        if not self.host_ok():
            self.send_error_json(403, "bad Host header")
            return
        if (self.headers.get("X-Reactor") or "").strip() != "1":
            self.send_error_json(403, "missing X-Reactor header")
            return

        body, error = self.read_body()
        if error is not None:
            self.send_error_json(400, error)
            return

        path = urlparse(self.path).path

        if path == "/api/mode":
            mode = body.get("mode")
            if not isinstance(mode, str):
                self.send_error_json(400, "mode must be a string")
                return
            ok, message = self.reactor.set_mode(mode)
            if not ok:
                self.send_error_json(400, message)
                return
            self.send_json(200, {"ok": True})
            return

        if path == "/api/curve":
            ok, message = self.reactor.set_curve(
                body.get("start_c"), body.get("full_c"))
            if not ok:
                self.send_error_json(400, message)
                return
            self.send_json(200, {"ok": True})
            return

        if path == "/api/manual":
            ok, message = self.reactor.set_manual_pct(body.get("pct"))
            if not ok:
                self.send_error_json(400, message)
                return
            self.send_json(200, {"ok": True})
            return

        if path == "/api/ack":
            self.reactor.alarms.ack()
            self.send_json(200, {"ok": True})
            return

        self.send_error_json(404, "unknown endpoint")


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="Reactor fan-control daemon (run as root)")
    parser.add_argument("--smcfan", default=DEFAULT_SMCFAN,
                        help="path to the smcfan helper")
    parser.add_argument("--macmon", default=DEFAULT_MACMON,
                        help="path to macmon")
    parser.add_argument("--ui", default=DEFAULT_UI,
                        help="static UI folder")
    parser.add_argument("--state-dir", default=DEFAULT_STATE_DIR,
                        help="folder holding config.json")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help="HTTP port on 127.0.0.1")
    parser.add_argument("--dry-run", action="store_true",
                        help="never change fan speeds; log what would happen")
    parser.add_argument("--log-file", default=LOG_PATH,
                        help="event log file (default %s)" % LOG_PATH)
    return parser.parse_args(argv)


def main(argv):
    args = parse_args(argv)
    if args.port < 1 or args.port > 65535:
        sys.stderr.write("reactord: invalid port %d\n" % args.port)
        return 2

    reactor = Reactor(args)

    def on_signal(signum, frame):
        sys.stderr.write("reactord: signal %d received, shutting down\n" % signum)
        reactor.stop.set()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    atexit.register(reactor.release, "atexit")

    try:
        reactor.start()
    except Exception:
        sys.stderr.write("reactord: fatal error:\n")
        traceback.print_exc()
        return 1
    finally:
        reactor.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
