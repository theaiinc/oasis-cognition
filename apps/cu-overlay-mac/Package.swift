// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "OasisCUOverlay",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "OasisCUOverlay", targets: ["OasisCUOverlay"])
    ],
    targets: [
        .executableTarget(
            name: "OasisCUOverlay",
            path: "Sources/OasisCUOverlay"
        )
    ]
)
