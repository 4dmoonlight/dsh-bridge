// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "relay-sync",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "relay-sync", targets: ["RelaySyncCLI"]),
        .library(name: "RelaySyncKit", targets: ["RelaySyncKit"]),
    ],
    targets: [
        .target(name: "RelaySyncKit"),
        .executableTarget(
            name: "RelaySyncCLI",
            dependencies: ["RelaySyncKit"],
            path: "Sources/RelaySyncCLI"
        ),
        .testTarget(name: "RelaySyncKitTests", dependencies: ["RelaySyncKit"]),
    ]
)
