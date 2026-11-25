import AppKit
import Foundation
import Dispatch
import BridgeSyncKit

// dsh-bridge — macOS side of dsh-bridge.

// Commands:
//   register  pair this Mac with a hub (saves a device token)
//   push      read local DSH sessions and push them to the hub
//   serve     host mode: keep a command poll parked and re-push periodically
//   list      list sessions stored on the hub
//   show      print one synced session
//   config    show the local config location and values (tokens masked)
//   doctor    check local prerequisites (sessions dir, zstd, hub health)
//   ui        open the SwiftUI window

struct Options {
    var command: String = "help"
    var positionals: [String] = []
    var flags: [String: String] = [:]
    var switches: Set<String> = []

    func value(_ name: String, default fallback: String? = nil) -> String? {
        flags[name] ?? fallback
    }

    func flag(_ name: String) -> Bool { switches.contains(name) }
}

func parseArguments(_ arguments: [String]) -> Options {
    var options = Options()
    var index = 0
    let booleanFlags: Set<String> = ["json", "full", "help", "verbose"]
    while index < arguments.count {
        let argument = arguments[index]
        if argument.hasPrefix("--") {
            let trimmed = String(argument.dropFirst(2))
            if booleanFlags.contains(trimmed) {
                options.switches.insert(trimmed)
            } else if let equals = trimmed.firstIndex(of: "=") {
                let key = String(trimmed[trimmed.startIndex..<equals])
                let value = String(trimmed[trimmed.index(after: equals)...])
                options.flags[key] = value
            } else if index + 1 < arguments.count, !arguments[index + 1].hasPrefix("--") {
                options.flags[trimmed] = arguments[index + 1]
                index += 1
            } else {
                options.switches.insert(trimmed)
            }
        } else if options.command == "help" && options.positionals.isEmpty {
            options.command = argument
        } else {
            options.positionals.append(argument)
        }
        index += 1
    }
    return options
}

func expand(_ path: String) -> String {
    (path as NSString).expandingTildeInPath
}

func printUsage() {
    print("""
    dsh-bridge — session sync for DeepSeek Harness (macOS)

    USAGE
      dsh-bridge <command> [options]

    COMMANDS
      register   --hub URL --token TOKEN [--name NAME]   pair this Mac with a hub
      push       [--limit N] [--full] [--json]             push local DSH sessions
      serve      [--push-every 30] [--poll-wait 20]        host mode (hub live commands)
      list       [--limit N] [--query Q] [--json]          list sessions on the hub
      show       <session-id> [--json]                     print one synced session
      config     [--json]                                  show local config
      doctor     [--json]                                  check prerequisites
      ui                                                   open the macOS window

    OPTIONS
      --config PATH        config file (default ~/.dsh-bridge/macos.json)
      --sessions-dir PATH  DSH sessions root (default ~/.dsh/sessions)
      --hub URL          hub base URL (overrides config)
      --token TOKEN        instance token (overrides config)
      --json               machine-readable output

    ENV
      HUB_URL, BRIDGE_TOKEN   same as --hub / --token
    """)
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(("[dsh-bridge] " + message + "\n").data(using: .utf8)!)
    exit(code)
}

func makeStore(_ options: Options) -> ConfigStore {
    ConfigStore(path: options.value("config").map { URL(fileURLWithPath: expand($0)) })
}

func loadConfigOrFail(_ options: Options, store: ConfigStore) -> MacConfig {
    let maybe = (try? store.load()) ?? nil
    guard var config = maybe else {
        fail("no config at " + store.path.path + " — run: dsh-bridge register --hub URL --token TOKEN")
    }
    if let hub = options.value("hub") { config.hubURL = hub }
    if let token = options.value("token") { config.instanceToken = token }
    return config
}

func makeEngine(_ options: Options, config: MacConfig, store: ConfigStore, env: [String: String]) throws -> SyncEngine {
    let rootPath = options.value("sessions-dir")
        ?? env["DSH_SESSIONS_DIR"]
        ?? DSHReader.defaultRoot().path
    let reader = DSHReader(root: URL(fileURLWithPath: expand(rootPath)))
    let client = try store.client(for: config, timeout: 45)
    return SyncEngine(reader: reader, client: client)
}

let environment = ProcessInfo.processInfo.environment
let options = parseArguments(Array(CommandLine.arguments.dropFirst()))
if options.flag("help") { printUsage(); exit(0) }

let store = makeStore(options)
let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]

switch options.command {
case "help":
    printUsage()

case "register":
    guard let hubURL = options.value("hub") ?? environment["HUB_URL"] else {
        fail("--hub URL is required (or set HUB_URL)")
    }
    guard let instanceToken = options.value("token") ?? environment["BRIDGE_TOKEN"] else {
        fail("--token is required (or set BRIDGE_TOKEN)")
    }
    let deviceName = options.value("name") ?? Host.current().localizedName ?? ProcessInfo.processInfo.hostName
    guard let url = URL(string: hubURL) else { fail("invalid hub URL: " + hubURL) }
    let client = HubClient(baseURL: url, token: instanceToken)
    do {
        let response = try await client.register(
            name: deviceName,
            platform: "macos",
            hostname: ProcessInfo.processInfo.hostName
        )
        var config = MacConfig(hubURL: hubURL, instanceToken: instanceToken, deviceName: deviceName)
        config.deviceId = response.device.id
        config.deviceToken = response.token
        try store.save(config)
        if options.flag("json") {
            print(String(data: try encoder.encode(config), encoding: .utf8) ?? "{}")
        } else {
            print("registered device " + response.device.id + " as " + response.device.name)
            print("config written to " + store.path.path)
        }
    } catch {
        fail(String(describing: error))
    }

case "push":
    let config = loadConfigOrFail(options, store: store)
    let engine = try makeEngine(options, config: config, store: store, env: environment)
    do {
        let limit = Int(options.value("limit", default: "50") ?? "50") ?? 50
        let report = try await engine.push(limit: limit, full: options.flag("full"))
        if options.flag("json") {
            print("{\"pushed\":\(report.pushed),\"skipped\":\(report.skipped),\"removed\":\(report.removed),\"scanned\":\(report.scanned)}")
        } else {
            print("scanned \(report.scanned) session(s): pushed \(report.pushed), skipped \(report.skipped), removed \(report.removed)")
        }
    } catch {
        fail(String(describing: error))
    }

case "serve":
    let config = loadConfigOrFail(options, store: store)
    let engine = try makeEngine(options, config: config, store: store, env: environment)
    let pushEvery = Double(options.value("push-every", default: "30") ?? "30") ?? 30
    let pollWait = Int(options.value("poll-wait", default: "20") ?? "20") ?? 20
    signal(SIGINT, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    source.setEventHandler { print("stopping host loop"); exit(0) }
    source.resume()
    print("host mode: hub " + config.hubURL + ", device " + (config.deviceId ?? "unregistered"))
    await engine.serveHost(pushEverySeconds: pushEvery, pollWaitSeconds: pollWait) { line in
        print("[dsh-bridge] " + line)
    }

case "list":
    let config = loadConfigOrFail(options, store: store)
    let client = try store.client(for: config)
    do {
        let limit = Int(options.value("limit", default: "50") ?? "50") ?? 50
        let response = try await client.listSessions(limit: limit, query: options.value("query"))
        if options.flag("json") {
            print(String(data: try encoder.encode(response), encoding: .utf8) ?? "{}")
        } else if response.sessions.isEmpty {
            print("no sessions on the hub yet")
        } else {
            for item in response.sessions {
                print(item.updatedAt + "  " + item.id + "  [" + String(item.messageCount) + " msgs]  " + item.title)
            }
            print("(\(response.sessions.count) shown, total \(response.total ?? response.sessions.count))")
        }
    } catch {
        fail(String(describing: error))
    }

case "show":
    guard let sessionId = options.positionals.first else { fail("usage: dsh-bridge show <session-id>") }
    let config = loadConfigOrFail(options, store: store)
    let client = try store.client(for: config)
    do {
        let session = try await client.session(id: sessionId)
        if options.flag("json") {
            print(String(data: try encoder.encode(session), encoding: .utf8) ?? "{}")
        } else {
            print("# " + session.title)
            print("id: " + session.id + "  workspace: " + session.workspace + "  updated: " + session.updatedAt)
            for message in session.messages {
                print("\n[" + message.role + "] " + message.text)
            }
        }
    } catch {
        fail(String(describing: error))
    }

case "config":
    let maybe = (try? store.load()) ?? nil
    if let loaded = maybe {
        if options.flag("json") {
            print(String(data: try encoder.encode(loaded), encoding: .utf8) ?? "{}")
        } else {
            print("path: " + store.path.path)
            print("hub: " + loaded.hubURL)
            print("device: " + (loaded.deviceId ?? "-") + "  name: " + loaded.deviceName)
            print("device token: " + mask(loaded.deviceToken))
            print("instance token: " + mask(loaded.instanceToken))
            print("last sync: " + (loaded.lastSyncAt ?? "-"))
        }
    } else {
        print("no config at " + store.path.path)
        exit(1)
    }

case "doctor":
    var checks: [[String: String]] = []
    let sessionsRoot = options.value("sessions-dir") ?? environment["DSH_SESSIONS_DIR"] ?? DSHReader.defaultRoot().path
    checks.append(check("sessions-dir", FileManager.default.fileExists(atPath: expand(sessionsRoot)), expand(sessionsRoot)))
    let zstd = which("zstd")
    checks.append(check("zstd", zstd != nil, zstd ?? "missing — brew install zstd"))
    let maybeConfig = (try? store.load()) ?? nil
    checks.append(check("config", maybeConfig != nil, store.path.path))
    if let config = maybeConfig {
        do {
            let client = try store.client(for: config)
            let health = try await client.health()
            checks.append(check("hub", (health["ok"] as? Bool) == true, config.hubURL))
        } catch {
            checks.append(check("hub", false, String(describing: error)))
        }
    }
    if options.flag("json") {
        let data = try JSONSerialization.data(withJSONObject: checks, options: [.prettyPrinted])
        print(String(data: data, encoding: .utf8) ?? "[]")
    } else {
        for item in checks {
            print((item["ok"] == "true" ? "ok   " : "FAIL ") + (item["name"] ?? "") + ": " + (item["detail"] ?? ""))
        }
    }
    if checks.contains(where: { $0["ok"] != "true" }) { exit(1) }

case "ui":
    if options.flag("json") { fail("ui does not support --json") }
    runUI(configStore: store, sessionsRoot: options.value("sessions-dir"))

default:
    fail("unknown command: " + options.command + "\n\nrun: dsh-bridge help")
}

func mask(_ value: String?) -> String {
    guard let value else { return "-" }
    guard value.count > 8 else { return "***" }
    return String(value.prefix(4)) + "…" + String(value.suffix(4))
}

func check(_ name: String, _ ok: Bool, _ detail: String) -> [String: String] {
    ["name": name, "ok": ok ? "true" : "false", "detail": detail]
}

func which(_ tool: String) -> String? {
    let paths = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
    for directory in paths {
        let candidate = directory + "/" + tool
        if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
    }
    return nil
}
