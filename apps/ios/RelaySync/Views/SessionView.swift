import SwiftUI

/// 会话消息:进入时拉全量,之后每 3 秒增量拉取。
struct SessionView: View {
  @EnvironmentObject private var store: Store
  let session: SessionSummary

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 10) {
          if let err = store.messagesError {
            Text(err).font(.footnote).foregroundStyle(.red)
          }
          if store.messages.isEmpty && store.messagesError == nil {
            ProgressView().padding()
          }
          ForEach(store.messages) { message in
            MessageRow(message: message).id(message.id)
          }
        }
        .padding(12)
      }
      .onChange(of: store.messages.count) { _, _ in
        if let last = store.messages.last {
          withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
        }
      }
    }
    .navigationTitle(session.title.isEmpty ? "会话" : session.title)
    .navigationBarTitleDisplayMode(.inline)
    .task { store.open(session) }
    .onDisappear { store.closeSession() }
  }
}

struct MessageRow: View {
  let message: Message

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(message.role == "user" ? "用户" : "助手")
        .font(.caption2)
        .foregroundStyle(.secondary)
      Text(message.content)
        .font(.callout)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(10)
    .background(
      RoundedRectangle(cornerRadius: 10)
        .fill(message.isUser ? Color.accentColor.opacity(0.12) : Color(uiColor: .secondarySystemBackground))
    )
  }
}
