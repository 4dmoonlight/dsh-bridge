import SwiftUI

/// 首次使用:输入中继地址 + 旧设备上的 6 位配对码。全程不需要手抄 token。
struct PairingView: View {
  @EnvironmentObject private var store: Store
  @State private var relayText = ""
  @State private var code = ""

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("https://relay.example.com", text: $relayText)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.URL)
        } header: {
          Text("中继地址")
        } footer: {
          Text("和你其他电脑上填的是同一个地址。")
        }

        Section {
          TextField("6 位配对码", text: $code)
            .keyboardType(.numberPad)
            .onChange(of: code) { _, newValue in
              code = String(newValue.filter { $0.isNumber }.prefix(6))
            }
        } header: {
          Text("配对码")
        } footer: {
          Text("在已连接的电脑上点「添加设备」获取,10 分钟内有效,且只能用一次。")
        }

        if let err = store.pairingError {
          Section {
            Text(err).foregroundStyle(.red).font(.footnote)
          }
        }

        Section {
          Button {
            Task { await store.pair(relayText: relayText, code: code) }
          } label: {
            HStack {
              Spacer()
              if store.isPairing {
                ProgressView()
              } else {
                Text("配对").bold()
              }
              Spacer()
            }
          }
          .disabled(store.isPairing || code.count != 6 || relayText.isEmpty)
        }
      }
      .navigationTitle("连接中继")
      .task {
        // 预填"上次用过的地址",而不是把某个具体部署写死进源码。
        if relayText.isEmpty, let saved = Keychain.get("relay_url") {
          relayText = saved
        }
      }
    }
  }
}
