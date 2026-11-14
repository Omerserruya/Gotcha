import Capacitor
import UIKit

/// The app's root view controller: Capacitor's bridge plus the local plugins
/// that live in this target (they are not npm packages, so Capacitor cannot
/// discover them on its own).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NavigationPolicyPlugin())
    }
}
