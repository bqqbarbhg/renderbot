import json
import argparse
import sys
import os
import asyncio
import time
import traceback

parser = argparse.ArgumentParser(description="Maya render automation")
parser.add_argument("config", nargs="?", help="Configuration .json file", default="renderbot.json")
parser.add_argument("--root", nargs="?", help="Root directory")
argv = parser.parse_args(sys.argv[1:])

with open(argv.config) as f:
    config = json.load(f)

def merge_dict(x, y):
    z = x.copy()
    z.update(y)
    return z

def log_bytes(b):
    if b: print(b.encode("utf-8"))

async def render_communicate(proc, take, config):
    name = take["name"]

    last_ping = time.time()
    code = -99999
    while True:
        try:
            code = await asyncio.wait_for(proc.wait(), timeout=0.1)
            break
        except asyncio.TimeoutError:
            pass
        except asyncio.CancelledError:
            pass

        if (time.time() - last_ping) > 60*10:
            break

        try:
            for n in range(20):
                line = await asyncio.wait_for(proc.stdout.readline(), timeout=5)
                line = line.strip()
                if line:
                    last_ping = time.time()
                    print(line.decode("utf-8", errors="ignore"), flush=True)
                if (time.time() - last_ping) > 5: break
        except asyncio.TimeoutError:
            if (time.time() - last_ping) > 30:
                print("No response.. trying to send CRLF", flush=True)
                try:
                    await asyncio.wait_for(proc.stdin.write(b"\r\n"), timeout=5)
                except asyncio.TimeoutError:
                    print("Failed to send CRLF...", flush=True)
        except asyncio.CancelledError:
            pass
    
    print("")
    print(f"=== Finished render '{name}' ===")
    print("")
    if code == -99999:
        print("Timeout... Renderer probably hanged")
    else:
        if code == 0:
            print("Success!")
        else:
            print(f"Error code: {code}")
    return code

async def render_take(take, config):
    take = merge_dict(config.get("defaults", {}), take)
    render_exe = config["render-exe"]
    root = config.get("root-dir", ".")
    if argv.root: root = argv.root
    name, filename = take["name"], take["file"]
    start, end = take["start"], take["end"]
    step = take.get("step", 1)

    args = [render_exe]

    # Frame range
    args += ["-s", str(start)]
    args += ["-e", str(end)]
    args += ["-b", str(step)]

    # User arguments
    args += ["-r", take.get("renderer", "arnold")]
    args += ["-rd", take.get("output", ".")]
    args += ["-skipExistingFrames", ["false", "true"][take.get("skipExisting", False)]]

    # Finish with filename
    args.append(os.path.join(root, filename))

    print("")
    print(f"=== Starting render '{name}' ===")
    print("")
    print("$ " + " ".join(args), flush=True)
    print("")

    proc = await asyncio.subprocess.create_subprocess_exec(*args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        cwd=root,
    )

    return await render_communicate(proc, take, config)

for take in config["takes"]:
    for n in range(10):
        try:
            code = asyncio.run(render_take(take, config))
            if code == 0:
                break
        except:
            print("")
            print("=== renderbot.py internal error ===")
            print("")
            traceback.print_exc()
