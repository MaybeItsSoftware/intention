//
//  ShieldConfigurationExtension.swift
//  Intention Shield Extension
//
//  Custom copy for the system shield shown over blocked apps. iOS cannot
//  open another app from a shield, so the copy points the user at the
//  Intention app to talk to their coach.
//

#if os(iOS)
import ManagedSettings
import ManagedSettingsUI
import UIKit

class ShieldConfigurationExtension: ShieldConfigurationDataSource {

    private func intentionShield(for name: String?) -> ShieldConfiguration {
        ShieldConfiguration(
            backgroundBlurStyle: .systemMaterialDark,
            backgroundColor: UIColor(red: 0.06, green: 0.07, blue: 0.09, alpha: 1.0),
            icon: UIImage(systemName: "brain.head.profile"),
            title: ShieldConfiguration.Label(
                text: name.map { "\($0) is blocked" } ?? "This app is blocked",
                color: UIColor(red: 0.91, green: 0.91, blue: 0.92, alpha: 1.0)
            ),
            subtitle: ShieldConfiguration.Label(
                text: "You chose to block this. Open Intention and talk to your coach if you need time here.",
                color: UIColor(red: 0.63, green: 0.65, blue: 0.70, alpha: 1.0)
            ),
            primaryButtonLabel: ShieldConfiguration.Label(
                text: "OK",
                color: UIColor(red: 0.06, green: 0.07, blue: 0.09, alpha: 1.0)
            ),
            primaryButtonBackgroundColor: UIColor(red: 0.91, green: 0.91, blue: 0.92, alpha: 1.0)
        )
    }

    override func configuration(shielding application: Application) -> ShieldConfiguration {
        intentionShield(for: application.localizedDisplayName)
    }

    override func configuration(shielding application: Application, in category: ActivityCategory) -> ShieldConfiguration {
        intentionShield(for: application.localizedDisplayName)
    }
}
#endif
