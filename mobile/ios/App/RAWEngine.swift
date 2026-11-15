import Foundation

enum RAWEngine {
    enum Look: String, CaseIterable, Identifiable, Sendable {
        case signature = "Signature"
        case neutral = "Neutral"
        var id: Self { self }
    }

    struct Adjustments: Equatable, Sendable {
        var look: Look = .signature
        var exposure: Double = 0
    }

    struct Session: Sendable {
        let folder: URL
        let input: URL
        let filename: String
    }

    private struct Failure: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }

    private static let queue = DispatchQueue(label: "app.yellowmoon.develop", qos: .userInitiated)

    private static func run<T: Sendable>(
        _ operation: @escaping @Sendable () throws -> T
    ) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { continuation.resume(with: Result(catching: operation)) }
        }
    }

    static func importFile(_ source: URL) async throws -> Session {
        try await run {
            guard source.pathExtension.lowercased() == "arw" else {
                throw Failure("Choose a Sony .ARW file from Files.")
            }
            let granted = source.startAccessingSecurityScopedResource()
            defer { if granted { source.stopAccessingSecurityScopedResource() } }
            let root = try FileManager.default.url(
                for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true
            ).appendingPathComponent("YellowmoonSessions", isDirectory: true)
            // Each scene owns its session. Reap abandoned sessions after a day.
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            if let children = try? FileManager.default.contentsOfDirectory(
                at: root, includingPropertiesForKeys: [.contentModificationDateKey]
            ) {
                for child in children {
                    if let modified = try? child.resourceValues(
                        forKeys: [.contentModificationDateKey]
                    ).contentModificationDate, Date().timeIntervalSince(modified) > 86400 {
                        try? FileManager.default.removeItem(at: child)
                    }
                }
            }
            let folder = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
            let input = folder.appendingPathComponent("source.ARW")
            do {
                var coordinatorError: NSError?
                var copyError: Error?
                NSFileCoordinator().coordinate(readingItemAt: source, options: [], error: &coordinatorError) { url in
                    do {
                        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize
                        guard let size, size > 0, size <= 128 * 1024 * 1024 else {
                            throw Failure("Choose a nonempty Sony RAW file smaller than 128 MB.")
                        }
                        try FileManager.default.copyItem(at: url, to: input)
                    } catch { copyError = error }
                }
                if let coordinatorError { throw coordinatorError }
                if let copyError { throw copyError }
                return Session(folder: folder, input: input, filename: source.lastPathComponent)
            } catch {
                try? FileManager.default.removeItem(at: folder)
                throw error
            }
        }
    }

    static func develop(_ session: Session, settings: Adjustments, export: Bool) async throws -> URL {
        guard let data = Bundle.main.url(forResource: "data", withExtension: nil) else {
            throw Failure("Yellowmoon’s colour profiles are missing. Reinstall the app.")
        }
        return try await run {
            let output = session.folder.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: false)
            do {
                var error = [CChar](repeating: 0, count: 1024)
                let result = error.withUnsafeMutableBufferPointer { buffer in
                    ym_mobile_render(
                        data.path, session.input.path, output.path,
                        settings.look == .neutral ? 1 : 0, settings.exposure,
                        export ? 4096 : 1280, buffer.baseAddress, buffer.count
                    )
                }
                guard result == 0 else {
                    let message = String(decoding: error.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
                    throw Failure(message.isEmpty ? "Couldn’t develop this RAW file." : message)
                }
                let jpeg = output.appendingPathComponent("developed.jpg")
                guard FileManager.default.fileExists(atPath: jpeg.path) else {
                    throw Failure("No JPEG was produced.")
                }
                if export {
                    let name = URL(fileURLWithPath: session.filename).deletingPathExtension().lastPathComponent
                    let named = output.appendingPathComponent(name + "-Yellowmoon.jpg")
                    try FileManager.default.moveItem(at: jpeg, to: named)
                    return named
                }
                return jpeg
            } catch {
                try? FileManager.default.removeItem(at: output)
                throw error
            }
        }
    }
}
