import AppKit
import SwiftUI

// MARK: - Model

enum Role { case user, assistant, toolHeader, toolLine }

enum Verdict: Equatable {
    case keep(String)
    case drop(String)

    var isDrop: Bool {
        if case .drop = self { return true }
        return false
    }
}

struct Chunk: Identifiable, Equatable {
    let id: Int
    let role: Role
    let text: String
    let kind: String
    let drop: Double
    let recent: Bool

    var verdict: Verdict {
        if recent { return .keep("recent") }
        if kind == "user_instruction" || kind == "pending_task" { return .keep("protected") }
        if drop >= 0.8 { return .drop(String(format: "drop %.2f", drop)) }
        if drop >= 0.5 { return .keep(String(format: "%.2f < 0.80", drop)) }
        return .keep(String(format: "drop %.2f", drop))
    }
}

let transcript: [Chunk] = {
    var id = 0
    func c(_ role: Role, _ text: String, _ kind: String, _ drop: Double, recent: Bool = false) -> Chunk {
        id += 1
        return Chunk(id: id, role: role, text: text, kind: kind, drop: drop, recent: recent)
    }
    return [
        c(.user, "Fix quantities over 999. Keep the API unchanged.", "user_instruction", 0.06),
        c(.assistant, "Checking the parser…", "chatter", 0.93),
        c(.toolHeader, "Read(src/checkout/parser.ts)", "file_reference", 0.41),
        c(.toolLine, "Read 212 lines", "stale_tool_output", 0.97),
        c(.toolLine, "41  const qty = Number(raw.slice(0, 3));", "file_reference", 0.22),
        c(.toolHeader, "Bash(npm test -- parser)", "stale_tool_output", 0.84),
        c(.toolLine, "FAIL  expected 1200, received 120", "error", 0.09),
        c(.toolLine, "1 failed, 23 passed · 1.42s", "stale_tool_output", 0.95),
        c(.assistant, "Use a regex to capture the full quantity.", "decision", 0.14),
        c(.toolHeader, "Grep(parseLineItems)", "stale_tool_output", 0.86),
        c(.toolLine, "src/checkout/index.ts:14", "file_reference", 0.33),
        c(.toolHeader, "Edit(src/checkout/parser.ts)", "decision", 0.79),
        c(.toolLine, "Updated 1 file (+3 -1)", "stale_tool_output", 0.90),
        c(.assistant, "TODO: include the raw line in ParseError.", "pending_task", 0.12),
        c(.toolLine, "Tests: 24 passed", "stale_tool_output", 0.0, recent: true),
        c(.user, "Now fix the error message.", "user_instruction", 0.0, recent: true),
    ]
}()

// MARK: - Palette

enum Palette {
    static let bg = Color(red: 0.07, green: 0.07, blue: 0.09)
    static let panel = Color(red: 0.10, green: 0.10, blue: 0.12)
    static let fg = Color(red: 0.90, green: 0.90, blue: 0.92)
    static let dim = Color(red: 0.52, green: 0.53, blue: 0.58)
    static let border = Color(red: 0.24, green: 0.24, blue: 0.28)
    static let orange = Color(red: 0.85, green: 0.47, blue: 0.24)
    static let green = Color(red: 0.30, green: 0.85, blue: 0.48)
    static let red = Color(red: 0.96, green: 0.30, blue: 0.33)
    static let amber = Color(red: 0.98, green: 0.72, blue: 0.24)
    static let cyan = Color(red: 0.40, green: 0.78, blue: 0.95)
}

// MARK: - State

enum Phase { case idle, typing, waiting, scanning, collapsing, done }

enum DemoTokens {
    static let capacity = 200_000.0
    static let before = 156_000.0
    static let after = 62_000.0
}

@MainActor
final class Demo: ObservableObject {
    @Published var visible = transcript
    @Published var transcriptShown = false
    @Published var dropProgress = 0.0
    @Published var revealed: Set<Int> = []
    @Published var phase: Phase = .idle
    @Published var beamY: CGFloat? = nil
    @Published var tokens = DemoTokens.before
    @Published var status: String = ""
    @Published var summary: String? = nil

    private var task: Task<Void, Never>?
    var frames: [Int: CGRect] = [:]

    var context: Double { tokens / DemoTokens.capacity }

    func restart() {
        task?.cancel()
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            visible = transcript
            transcriptShown = false
            dropProgress = 0
            revealed = []
            beamY = nil
            tokens = DemoTokens.before
            status = ""
            summary = nil
            phase = .idle
        }
        task = Task { await run() }
    }

    private func run() async {
        let clock = ContinuousClock()
        let start = clock.now
        do {
            try await clock.sleep(until: start + .seconds(0.15))
            phase = .typing
            withAnimation(.easeOut(duration: 0.35)) {
                transcriptShown = true
            }

            try await clock.sleep(until: start + .seconds(0.5))
            phase = .waiting
            status = "Compacting context…"

            try await clock.sleep(until: start + .seconds(0.8))
            phase = .scanning
            status = "Jev is scanning…"
            if let first = transcript.first, let frame = frames[first.id] {
                beamY = frame.minY
            }
            try await clock.sleep(until: start + .seconds(0.85))
            if let last = transcript.last, let frame = frames[last.id] {
                withAnimation(.linear(duration: 1.5)) {
                    beamY = frame.maxY
                }
            }
            for (index, chunk) in transcript.enumerated() {
                let revealTime = 0.85 + 1.5 * Double(index + 1) / Double(transcript.count)
                try await clock.sleep(until: start + .seconds(revealTime))
                withAnimation(.easeOut(duration: 0.16)) {
                    _ = revealed.insert(chunk.id)
                }
            }
            try await clock.sleep(until: start + .seconds(2.5))
            withAnimation(.easeOut(duration: 0.2)) { beamY = nil }
            let dropped = transcript.filter { $0.verdict.isDrop }
            status = "\(dropped.count) to drop · \(transcript.count - dropped.count) to keep"

            try await clock.sleep(until: start + .seconds(3.05))
            phase = .collapsing
            status = "Removing clutter…"
            withAnimation(.easeInOut(duration: 0.85)) {
                dropProgress = 1
                tokens = DemoTokens.after
            }
            try await clock.sleep(until: start + .seconds(3.9))
            withAnimation(.easeInOut(duration: 0.4)) {
                visible.removeAll { $0.verdict.isDrop }
            }
            try await clock.sleep(until: start + .seconds(4.35))
            phase = .done
            status = "Context compacted"
            summary = "\(transcript.count - dropped.count) kept verbatim · \(dropped.count) removed"
        } catch {}
    }
}

// MARK: - Views

struct FrameKey: PreferenceKey {
    static var defaultValue: [Int: CGRect] = [:]
    static func reduce(value: inout [Int: CGRect], nextValue: () -> [Int: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { $1 })
    }
}

let mono = Font.system(size: 17, design: .monospaced)
let monoSmall = Font.system(size: 12.5, design: .monospaced)

struct ChunkView: View {
    let chunk: Chunk
    let revealed: Bool

    var shownText: String { chunk.text }

    var tint: Color? {
        guard revealed else { return nil }
        return chunk.verdict.isDrop ? Palette.red : Palette.green
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            content
            Spacer(minLength: 12)
            if revealed {
                badge
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 10)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill((tint ?? .clear).opacity(chunk.verdict.isDrop ? 0.16 : 0.10))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(tint ?? (chunk.role == .user ? Palette.border : .clear), lineWidth: 1.2)
        )
        .shadow(color: (tint ?? .clear).opacity(0.45), radius: revealed ? 10 : 0)
    }

    @ViewBuilder var content: some View {
        switch chunk.role {
        case .user:
            HStack(alignment: .top, spacing: 8) {
                Text(">").foregroundStyle(Palette.dim)
                Text(shownText).foregroundStyle(Palette.fg)
            }
        case .assistant:
            HStack(alignment: .top, spacing: 8) {
                Text("●").foregroundStyle(Palette.orange)
                Text(shownText).foregroundStyle(Palette.fg)
            }
        case .toolHeader:
            HStack(alignment: .top, spacing: 8) {
                Text("●").foregroundStyle(Palette.green)
                toolTitle
            }
        case .toolLine:
            HStack(alignment: .top, spacing: 8) {
                Text("  ⎿").foregroundStyle(Palette.dim)
                Text(chunk.text).foregroundStyle(Palette.dim)
            }
        }
    }

    var toolTitle: some View {
        let name = chunk.text.prefix { $0 != "(" }
        let rest = chunk.text.dropFirst(name.count)
        return (Text(String(name)).bold().foregroundStyle(Palette.fg)
            + Text(String(rest)).foregroundStyle(Palette.dim))
    }

    var badge: some View {
        let color = tint ?? Palette.dim
        return HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("p(drop) \(chunk.drop.formatted(.number.precision(.fractionLength(2)).locale(Locale(identifier: "en_US"))))")
                .monospacedDigit()
            Text(chunk.verdict.isDrop ? "DROP" : "KEEP")
                .bold()
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .background(RoundedRectangle(cornerRadius: 3).fill(color.opacity(0.22)))
        }
        .foregroundStyle(color)
        .font(monoSmall)
        .fixedSize()
    }
}

struct TokenCounter: View, Animatable {
    var value: Double

    var animatableData: Double {
        get { value }
        set { value = newValue }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            ZStack(alignment: .trailing) {
                Text(Int(DemoTokens.before).formatted(.number.locale(Locale(identifier: "en_US"))))
                    .hidden()
                    .accessibilityHidden(true)
                Text(Int(value.rounded()).formatted(.number.locale(Locale(identifier: "en_US"))))
            }
            .font(.system(size: 44, weight: .semibold, design: .monospaced))
            .tracking(-1.5)
            .monospacedDigit()
            .foregroundStyle(value < DemoTokens.before ? Palette.green : Palette.fg)
            Text("tokens")
                .font(monoSmall)
                .foregroundStyle(Palette.dim)
        }
        .fixedSize()
    }
}

struct ContextMeter: View {
    let value: Double
    let phase: Phase

    var color: Color {
        if phase == .done { return Palette.green }
        return value > 0.6 ? Palette.amber : Palette.dim
    }

    var body: some View {
        HStack(spacing: 8) {
            Text("Context")
                .foregroundStyle(Palette.dim)
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 3).fill(Palette.border).frame(width: 160, height: 8)
                RoundedRectangle(cornerRadius: 3).fill(color).frame(width: max(4, 160 * value), height: 8)
            }
            Text("\(Int(value * 100))%")
                .foregroundStyle(color)
                .frame(width: 44, alignment: .trailing)
                .contentTransition(.numericText())
        }
        .font(monoSmall)
    }
}

struct TerminalView: View {
    @ObservedObject var demo: Demo

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(spacing: 16) {
                HStack(alignment: .center) {
                    HStack(spacing: 14) {
                        Text("✻")
                            .font(.system(size: 30, design: .monospaced))
                            .foregroundStyle(Palette.orange)
                        TokenCounter(value: demo.tokens)
                    }
                    Spacer()
                    Text("fast-jev-compaction")
                        .font(monoSmall)
                        .foregroundStyle(Palette.dim)
                }
                Rectangle()
                    .fill(Palette.border.opacity(0.6))
                    .frame(height: 1)
            }
            .padding(.horizontal, 20)
            .padding(.top, 20)
            .padding(.bottom, 12)

            GeometryReader { container in
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(demo.visible) { chunk in
                        ChunkView(
                            chunk: chunk,
                            revealed: demo.revealed.contains(chunk.id)
                        )
                        .id(chunk.id)
                        .background(GeometryReader { g in
                            Color.clear.preference(
                                key: FrameKey.self,
                                value: [chunk.id: g.frame(in: .named("transcript"))]
                            )
                        })
                        .offset(x: chunk.verdict.isDrop ? container.size.width * demo.dropProgress : 0)
                        .opacity(chunk.verdict.isDrop ? 1 - demo.dropProgress : 1)
                        .transition(.opacity)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 6)
                .opacity(demo.transcriptShown ? 1 : 0)
                .offset(y: demo.transcriptShown ? 0 : 8)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .coordinateSpace(name: "transcript")
                .onPreferenceChange(FrameKey.self) { frames in
                    demo.frames = frames
                }
                .overlay(alignment: .top) {
                    if let y = demo.beamY {
                        beam.offset(y: y - 28)
                    }
                }
            }
            .font(mono)
            .clipped()

            footer
                .padding(.horizontal, 20)
                .padding(.bottom, 14)
                .padding(.top, 8)
        }
        .background(Palette.bg)
    }

    var beam: some View {
        VStack(spacing: 0) {
            LinearGradient(colors: [.clear, Palette.cyan.opacity(0.18)], startPoint: .top, endPoint: .bottom)
                .frame(height: 26)
            Rectangle().fill(Palette.cyan).frame(height: 2)
                .shadow(color: Palette.cyan, radius: 8)
        }
        .allowsHitTesting(false)
    }

    var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            statusLine
            HStack(spacing: 8) {
                Text(">").foregroundStyle(Palette.dim)
                Text(demo.phase == .done ? "" : " ")
                Rectangle().fill(Palette.fg).frame(width: 9, height: 18).opacity(cursorOn ? 1 : 0)
                Spacer()
            }
            .font(mono)
            .padding(.vertical, 8)
            .padding(.horizontal, 12)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.border, lineWidth: 1))
            HStack {
                Text("space to replay").foregroundStyle(Palette.dim).font(monoSmall)
                Spacer()
                ContextMeter(value: demo.context, phase: demo.phase)
            }
        }
    }

    @State private var cursorOn = true

    @ViewBuilder var statusLine: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                if demo.phase == .scanning || demo.phase == .collapsing {
                    Spinner()
                }
                Text(demo.status)
                    .foregroundStyle(statusColor)
                    .contentTransition(.opacity)
            }
            if let summary = demo.summary {
                Text(summary)
                    .foregroundStyle(Palette.dim)
                    .transition(.opacity)
            }
        }
        .font(monoSmall)
        .frame(minHeight: 36, alignment: .leading)
        .animation(.easeInOut(duration: 0.3), value: demo.status)
        .animation(.easeInOut(duration: 0.3), value: demo.summary)
    }

    var statusColor: Color {
        switch demo.phase {
        case .waiting: return Palette.amber
        case .scanning, .collapsing: return Palette.cyan
        case .done: return Palette.green
        default: return Palette.dim
        }
    }
}

struct Spinner: View {
    @State private var index = 0
    private let frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

    var body: some View {
        Text(frames[index])
            .foregroundStyle(Palette.cyan)
            .onReceive(Timer.publish(every: 0.08, on: .main, in: .common).autoconnect()) { _ in
                index = (index + 1) % frames.count
            }
    }
}

struct RootView: View {
    @StateObject private var demo = Demo()

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Text("claude — checkout-service")
                    .font(.system(size: 12.5))
                    .foregroundStyle(Palette.dim)
                Spacer()
            }
            .frame(height: 30)
            .background(Palette.panel)
            TerminalView(demo: demo)
        }
        .frame(minWidth: 1180, minHeight: 900)
        .background(Palette.bg)
        .onAppear {
            demo.restart()
            NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                if event.keyCode == 49 { // space
                    demo.restart()
                    return nil
                }
                return event
            }
        }
    }
}

@main
struct JevDemoApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentSize)
    }
}
