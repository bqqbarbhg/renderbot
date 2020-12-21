const path = require("path");
const { performance } = require("perf_hooks");
const fsp = require("fs").promises;
const { spawn } = require("child_process");
const { fail } = require("assert");

function parseArgs(argv) {
    const args = { };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith("--")) {
            if (++i >= process.argv) fail(`Expected value for '${arg}'`);
            args[arg.substring(2)] = argv[i];
        } else {
            args.configFiles = [...(args.configFiles || []), arg];
        }
    }
    return args;
}

function humanTimeMs(floatMs) {
    const ms = floatMs | 0;
    const s = ms / 1000 | 0;
    const m = s / 60 | 0;
    const h = m / 60 | 0;
    if (h > 0) {
        return `${h}h ${m%60}m`;
    } else if (m > 0) {
        return `${m}m ${s%60}s`;
    } else if (s > 0) {
        return `${s}s`;
    } else {
        return `${ms}ms`;
    }
}

function humanTimeS(floatSec) {
    return humanTimeMs(floatSec * 1000);
}

async function renderTake(args, config, take) {
    const {
        name = fail("Missing 'name': User-defined name for the take"),
        file = fail("Missing 'file': Maya scene .ma or .mb file to render"),
        renderExe = fail("Missing 'renderExe': path pointing to Maya Render.exe"),
        start = fail("Missing 'start': first frame to render"),
        end = fail("Missing 'end': last frame to render"),
        step = 1,
        rootDir = ".",
        outputDir = ".",
        renderer = "arnold",
        skipExistingFrames = false,
        pingWait = 30,
        pingInterval = 2,
        timeout = 15*60,
    } = { ...config, ...take, ...args };
    const renderArgs = {
        ...config.options,
        ...take.options,
        ...args.options,
    };

    const argv = [];

    // Output options
    argv.push("-rd", outputDir)
    argv.push("-r", renderer)

    // Frame range
    argv.push("-s", start)
    argv.push("-e", end)
    argv.push("-b", step)

    // Custom arguments
    for (const [key, value] of Object.entries(renderArgs)) {
        argv.push(`-${key}`, value.toString());
    }

    // Filename
    argv.push(file);

    console.log(`$ ${renderExe} ${argv.join(" ")}\n`);

    const proc = spawn(renderExe, argv, {
        cwd: rootDir,
    });

    let lastOutput = performance.now();

    // Forward stdout and stderr and keep track of last output
    proc.stdout.on("data", (data) => {
        lastOutput = performance.now();
        process.stdout.write(data);
    });
    proc.stderr.on("data", (data) => {
        lastOutput = performance.now();
        process.stderr.write(data);
    });

    // Spam CRLF to stdin if we haven't received any output in a while
    let shouldPrintCrlfInfo = true;
    const crlfSpamInterval = setInterval(() => {
        const ping = performance.now() - lastOutput;
        if (ping > pingWait*1000) {
            if (shouldPrintCrlfInfo) {
                console.log(`No input for ${humanTimeS(pingWait)}.. sending CRLF every ${humanTimeS(pingInterval)}s`);
                shouldPrintCrlfInfo = false;
            }
            try {
                proc.stdin.write("\r\n");
            } catch (error) {
                console.error("Sending CRLF failed..", error);
            }
        } else {
            shouldPrintCrlfInfo = true;
        }
    }, pingInterval*1000);

    // Terminate the program if we haven't received any output for a _long_ while
    const timeoutInterval = setInterval(() => {
        const ping = performance.now() - lastOutput;
        if (ping > timeout*1000) {
            console.log(`No input for ${humanTimeS(ping)}.. Assuming hand and attempting to terminate`);
            try {
                proc.kill();
            } catch (error) {
                console.error("Failed to terminate", error);
            }
        }
    }, 10000);

    await new Promise((resolve, reject) => {
        proc.on("exit", (code) => {
            clearInterval(crlfSpamInterval);
            clearInterval(timeoutInterval);
            if (code == 0) {
                resolve();
            } else {
                reject(new Error(`Process failed with code ${code}`));
            }
        });
    });
}

async function renderConfig(args, configFile) {
    const configData = await fsp.readFile(configFile, {
        encoding: "utf-8",
    })
    const config = JSON.parse(configData);

    const {
        takes = []
    } = { ...config, ...args };

    for (const take of takes) {
        const {
            name = fail("Missing 'name': User-defined name for the take"),
            restarts = 5,
        } = { ...config, ...take, ...args };

        console.log(`\n=== Starting take '${take.name}' ===\n`);

        const begin = performance.now();

        for (let restartI = 0; restartI <= restarts; restartI++) {
            try {
                await renderTake(args, config, take);
            } catch (error) {
                console.error("");
                console.error(error);
                console.error(`\n=== Take failed '${take.name}' ===\n`);
                if (restartI + 1 <= restarts) {
                    console.error(`... restarting ${restartI+1}/${restarts}\n`);
                }
            }
        }

        const end = performance.now();

        console.log(`\n=== Finished take '${take.name}' in ${humanTimeMs(end - begin)} ===\n`);
    }
}

async function main(args) {
    const {
        configFiles = ["renderbot.json"],
    } = args;

    console.log("\nUsing arguments:", args);
    for (const configFile of configFiles) {
        console.log(`\n=== Starting config '${configFile}' ===\n`);

        const begin = performance.now();
        await renderConfig(args, configFile);
        const end = performance.now();

        console.log(`\n=== Finished config '${configFile}' in ${humanTimeMs(end - begin)} ===\n`);
    }

}

const argv = process.argv.slice(2);
const args = parseArgs(argv);
main(args);
