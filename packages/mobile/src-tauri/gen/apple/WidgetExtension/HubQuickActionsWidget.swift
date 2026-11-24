import SwiftUI
import UIKit
import WidgetKit

private struct HubWidgetEntry: TimelineEntry {
    let date: Date
}

private struct HubWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> HubWidgetEntry {
        HubWidgetEntry(date: Date())
    }

    func getSnapshot(in context: Context, completion: @escaping (HubWidgetEntry) -> Void) {
        completion(HubWidgetEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<HubWidgetEntry>) -> Void) {
        completion(Timeline(entries: [HubWidgetEntry(date: Date())], policy: .never))
    }
}

private struct HubWidgetAction: Identifiable {
    let id: String
    let title: String
    let symbol: String

    var destination: URL {
        URL(string: "cihub://intent/\(id)")!
    }
}

private let hubWidgetActions = [
    HubWidgetAction(id: "home", title: "Open", symbol: "house"),
    HubWidgetAction(id: "connect", title: "Connect", symbol: "plus.circle"),
    HubWidgetAction(id: "switch", title: "Switch", symbol: "arrow.left.arrow.right"),
    HubWidgetAction(id: "settings", title: "Settings", symbol: "gearshape"),
]

private struct HubQuickActionsView: View {
    @Environment(\.widgetFamily) private var family

    private var visibleActions: [HubWidgetAction] {
        family == .systemSmall ? Array(hubWidgetActions.prefix(2)) : hubWidgetActions
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("QUICK ACTIONS")
                .font(.caption2.weight(.bold))
                .tracking(1.2)
                .foregroundStyle(Color.accentColor)

            if family == .systemSmall {
                VStack(spacing: 8) {
                    ForEach(visibleActions) { action in actionLink(action) }
                }
            } else {
                HStack(spacing: 8) {
                    ForEach(visibleActions) { action in actionLink(action) }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(12)
        .modifier(HubWidgetBackground())
    }

    private func actionLink(_ action: HubWidgetAction) -> some View {
        Link(destination: action.destination) {
            VStack(spacing: 5) {
                Image(systemName: action.symbol)
                    .font(.title3.weight(.medium))
                Text(action.title)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(.primary)
            .frame(maxWidth: .infinity, minHeight: 56)
            .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .accessibilityLabel("\(action.title) Companion Hub")
    }
}

private struct HubWidgetBackground: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            content.containerBackground(.background, for: .widget)
        } else {
            content.background(Color(.secondarySystemBackground))
        }
    }
}

private struct HubQuickActionsWidget: Widget {
    let kind = "CompanionHubQuickActions"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: HubWidgetProvider()) { _ in
            HubQuickActionsView()
        }
        .configurationDisplayName("Hub actions")
        .description("Open, connect, switch Hubs, or open settings.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

@main
struct CompanionHubWidgets: WidgetBundle {
    var body: some Widget {
        HubQuickActionsWidget()
    }
}
