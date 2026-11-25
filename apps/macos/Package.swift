// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "dsh-bridge",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "dsh-bridge", targets: ["BridgeSyncCLI"]),
        .library(name: "BridgeSyncKit", targets: ["BridgeSyncKit"]),
    ],
    targets: [
        .target(name: "BridgeSyncKit"),
        .executableTarget(
            name: "BridgeSyncCLI",
            dependencies: ["BridgeSyncKit"],
            path: "Sources/BridgeSyncCLI"
        ),
        .testTarget(name: "BridgeSyncKitTests", dependencies: ["BridgeSyncKit"]),
    ]
)
