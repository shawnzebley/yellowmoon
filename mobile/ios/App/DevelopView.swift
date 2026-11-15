import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct DevelopView: View {
    @State private var picking = false
    @State private var session: RAWEngine.Session?
    @State private var settings = RAWEngine.Adjustments()
    @State private var renderedSettings: RAWEngine.Adjustments?
    @State private var preview: UIImage?
    @State private var jpeg: URL?
    @State private var busy: String?
    @State private var failure: String?

    private let amber = Color(red: 1, green: 0.76, blue: 0.13)

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let session {
                        Text(session.filename)
                            .font(.headline)
                            .accessibilityAddTraits(.isHeader)
                        if let preview {
                            Image(uiImage: preview)
                                .resizable()
                                .scaledToFit()
                                .frame(maxWidth: .infinity)
                                .clipShape(RoundedRectangle(cornerRadius: 16))
                                .accessibilityLabel("Developed photo")
                        }
                        controls
                    } else {
                        ContentUnavailableView(
                            "Open a Sony RAW",
                            systemImage: "moon.stars",
                            description: Text("Choose an .ARW file from Files. Yellowmoon develops it on this iPhone.")
                        )
                        Button { picking = true } label: {
                            Label("Choose RAW", systemImage: "folder").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(busy != nil)
                        .accessibilityIdentifier("chooseRAW")
                    }
                    if let busy {
                        ProgressView(busy)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                    }
                }
                .padding(20)
                .frame(maxWidth: 680)
                .frame(maxWidth: .infinity)
            }
            .navigationTitle("Yellowmoon")
            .toolbar {
                if session != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Open", systemImage: "folder") { picking = true }
                            .disabled(busy != nil)
                            .accessibilityLabel("Open another RAW")
                    }
                }
            }
            .fileImporter(
                isPresented: $picking,
                allowedContentTypes: [UTType(filenameExtension: "arw") ?? .rawImage]
            ) { result in
                switch result {
                case .success(let url): open(url)
                case .failure(let error): failure = error.localizedDescription
                }
            }
            .alert("Couldn’t finish", isPresented: Binding(
                get: { failure != nil }, set: { if !$0 { failure = nil } }
            )) {
                Button("OK", role: .cancel) { failure = nil }
            } message: {
                Text(failure ?? "")
            }
        }
        .tint(amber)
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 14) {
            Picker("Look", selection: $settings.look) {
                ForEach(RAWEngine.Look.allCases) { look in Text(look.rawValue).tag(look) }
            }
            .pickerStyle(.segmented)
            Slider(value: $settings.exposure, in: -2...2, step: 0.1) {
                Text("Exposure")
            } minimumValueLabel: {
                Text("−2")
            } maximumValueLabel: {
                Text("+2")
            }
            .accessibilityValue(Text(exposureLabel))
            Text("Exposure \(exposureLabel)")
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Button("Update preview", systemImage: "arrow.clockwise") { develop(export: false) }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .disabled(busy != nil || renderedSettings == settings)
            if let jpeg, renderedSettings == settings {
                ShareLink(item: jpeg) {
                    Label("Share JPEG", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(busy != nil)
            } else {
                Button { develop(export: true) } label: {
                    Label("Prepare JPEG", systemImage: "photo").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(busy != nil)
            }
            Text("JPEG export: up to 4096 px on the long edge.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .disabled(busy != nil)
        .onChange(of: settings) { _, _ in
            if let jpeg { removeOutput(jpeg) }
            jpeg = nil
        }
    }

    private var exposureLabel: String {
        settings.exposure.formatted(.number.sign(strategy: .always()).precision(.fractionLength(1))) + " EV"
    }

    private func open(_ url: URL) {
        guard busy == nil else { return }
        busy = "Opening and developing RAW…"
        Task {
            defer { busy = nil }
            var imported: RAWEngine.Session?
            defer { if let imported { try? FileManager.default.removeItem(at: imported.folder) } }
            do {
                let new = try await RAWEngine.importFile(url)
                imported = new
                let defaults = RAWEngine.Adjustments()
                let output = try await RAWEngine.develop(new, settings: defaults, export: false)
                guard let image = loadPreview(output) else { return }
                if let session { try? FileManager.default.removeItem(at: session.folder) }
                session = new
                imported = nil
                settings = defaults
                renderedSettings = defaults
                preview = image
                jpeg = nil
            } catch { failure = error.localizedDescription }
        }
    }

    private func develop(export: Bool) {
        guard let session, busy == nil else { return }
        let selected = settings
        busy = export ? "Preparing JPEG…" : "Updating preview…"
        Task {
            defer { busy = nil }
            do {
                // Keep the shared JPEG and the displayed preview on the same settings.
                if renderedSettings != selected {
                    let output = try await RAWEngine.develop(session, settings: selected, export: false)
                    guard let image = loadPreview(output) else { return }
                    preview = image
                    renderedSettings = selected
                }
                if export { jpeg = try await RAWEngine.develop(session, settings: selected, export: true) }
            } catch { failure = error.localizedDescription }
        }
    }

    private func loadPreview(_ url: URL) -> UIImage? {
        defer { removeOutput(url) }
        if let data = try? Data(contentsOf: url), let image = UIImage(data: data) { return image }
        failure = "Couldn’t display the developed photo."
        return nil
    }

    private func removeOutput(_ url: URL) {
        try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
    }
}
