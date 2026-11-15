import SwiftUI

@main
struct YellowmoonApp: App {
    var body: some Scene {
        WindowGroup {
            DevelopView()
                .preferredColorScheme(.dark)
        }
    }
}
