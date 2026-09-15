// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "pico-dictate",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.15.0"),
    ],
    targets: [
        .executableTarget(
            name: "pico-dictate",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
            path: "Sources/pico-dictate",
            exclude: ["Info.plist"],
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", "Sources/pico-dictate/Info.plist"]),
            ]
        ),
        .testTarget(name: "pico-dictateTests", dependencies: ["pico-dictate"]),
    ]
)
