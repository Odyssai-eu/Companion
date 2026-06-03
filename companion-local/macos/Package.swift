// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "CompanionLocal",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "CompanionLocal",
            path: "Sources/CompanionLocal"
        )
    ]
)
