<?php
/**
 * Plugin Name:       GOTCHA for WooCommerce
 * Description:       The GOTCHA chat on your store: your AI employee answers your customers, with your products and orders.
 * Version:           0.1.0
 * Requires at least: 6.4
 * Requires PHP:      7.4
 * Author:            GOTCHA
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       gotcha-for-woocommerce
 * WC requires at least: 8.0
 *
 * Contract: docs/api/woocommerce-plugin-v1.md (GOTCHA repository).
 * Every widget setting lives in GOTCHA; this plugin only connects the store,
 * puts the chat on its pages, and tells GOTCHA when it is (de)activated.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'GOTCHA_WC_VERSION', '0.1.0' );
if ( ! defined( 'GOTCHA_APP_URL' ) ) {
	// The GOTCHA that served this zip writes its own address here when the zip
	// is downloaded (a dev GOTCHA gives dev, production gives production).
	// Overridable in wp-config.php.
	define( 'GOTCHA_APP_URL', '__GOTCHA_APP_URL__' );
}

const GOTCHA_WC_OPT_WIDGET    = 'gotcha_wc_widget_id';
const GOTCHA_WC_OPT_KEY       = 'gotcha_wc_site_key';
const GOTCHA_WC_OPT_API       = 'gotcha_wc_api_url';
const GOTCHA_WC_OPT_SCRIPT    = 'gotcha_wc_script_url';
const GOTCHA_WC_OPT_WORKSPACE = 'gotcha_wc_workspace';
const GOTCHA_WC_NONCE         = 'gotcha_wc_connect_nonce';
const GOTCHA_WC_CRON          = 'gotcha_wc_heartbeat';

/** Is this site connected to a GOTCHA workspace? */
function gotcha_wc_connected() {
	return (bool) get_option( GOTCHA_WC_OPT_KEY ) && (bool) get_option( GOTCHA_WC_OPT_WIDGET );
}

/** Tell GOTCHA what happened (activated / deactivated / uninstalled / disconnected / heartbeat). */
function gotcha_wc_signal( $event, $blocking = true ) {
	$key = get_option( GOTCHA_WC_OPT_KEY );
	$api = get_option( GOTCHA_WC_OPT_API );
	if ( ! $key || ! $api ) {
		return;
	}
	global $wp_version;
	$response = wp_remote_post(
		untrailingslashit( $api ) . '/api/woocommerce-plugin/signal',
		array(
			'timeout'  => 5,
			'blocking' => $blocking,
			'headers'  => array(
				'Authorization' => 'Bearer ' . $key,
				'Content-Type'  => 'application/json',
			),
			'body'     => wp_json_encode(
				array(
					'event'         => $event,
					'pluginVersion' => GOTCHA_WC_VERSION,
					'wpVersion'     => $wp_version,
					'wcVersion'     => defined( 'WC_VERSION' ) ? WC_VERSION : null,
					'siteUrl'       => home_url(),
				)
			),
		)
	);
	// GOTCHA no longer knows this key (removed there): forget it here too.
	if ( $blocking && ! is_wp_error( $response ) && 401 === (int) wp_remote_retrieve_response_code( $response ) ) {
		gotcha_wc_forget();
	}
}

function gotcha_wc_forget() {
	foreach ( array( GOTCHA_WC_OPT_WIDGET, GOTCHA_WC_OPT_KEY, GOTCHA_WC_OPT_API, GOTCHA_WC_OPT_SCRIPT, GOTCHA_WC_OPT_WORKSPACE ) as $opt ) {
		delete_option( $opt );
	}
}

// ─── Activation, deactivation, the daily heartbeat ─────────────────

register_activation_hook(
	__FILE__,
	function () {
		if ( ! wp_next_scheduled( GOTCHA_WC_CRON ) ) {
			wp_schedule_event( time() + HOUR_IN_SECONDS, 'daily', GOTCHA_WC_CRON );
		}
		gotcha_wc_signal( 'activated' );
	}
);

register_deactivation_hook(
	__FILE__,
	function () {
		wp_clear_scheduled_hook( GOTCHA_WC_CRON );
		gotcha_wc_signal( 'deactivated', false );
	}
);

add_action(
	GOTCHA_WC_CRON,
	function () {
		gotcha_wc_signal( 'heartbeat' );
	}
);

// ─── The chat on the storefront ──────────────────────────────────

add_action(
	'wp_footer',
	function () {
		if ( is_admin() || ! gotcha_wc_connected() ) {
			return;
		}
		// Not while the shopper pays.
		if ( function_exists( 'is_checkout_pay_page' ) && is_checkout_pay_page() ) {
			return;
		}
		$config = array(
			'widgetId' => (string) get_option( GOTCHA_WC_OPT_WIDGET ),
			'apiUrl'   => (string) get_option( GOTCHA_WC_OPT_API ),
			'platform' => 'woocommerce',
		);
		$script = esc_url( (string) get_option( GOTCHA_WC_OPT_SCRIPT ) );
		// With the WP Consent API (cookie plugins), the chat waits for "functional" consent.
		$needs_consent = function_exists( 'wp_has_consent' ) && ! wp_has_consent( 'functional' );
		?>
<script>window.__chatcenter = <?php echo wp_json_encode( $config ); ?>;</script>
		<?php if ( ! $needs_consent ) : ?>
<script src="<?php echo $script; // phpcs:ignore WordPress.Security.EscapeOutput -- escaped above ?>" async></script>
		<?php else : ?>
<script>
document.addEventListener("wp_listen_for_consent_change", function (e) {
	var c = e.detail || {};
	if (c.functional === "allow" && !window.__chatcenterLoaded) {
		window.__chatcenterLoaded = true;
		var s = document.createElement("script"); s.src = <?php echo wp_json_encode( $script ); ?>; s.async = true; document.body.appendChild(s);
	}
});
</script>
		<?php endif; ?>
		<?php
	}
);

// ─── WP Admin: WooCommerce → GOTCHA ──────────────────────────────

add_action(
	'admin_menu',
	function () {
		add_submenu_page( 'woocommerce', 'GOTCHA', 'GOTCHA', 'manage_woocommerce', 'gotcha-for-woocommerce', 'gotcha_wc_settings_page' );
	}
);

function gotcha_wc_settings_url() {
	return admin_url( 'admin.php?page=gotcha-for-woocommerce' );
}

/** Back from GOTCHA with a one-time code: trade it (server to server) for the widget id and the site key. */
function gotcha_wc_handle_return() {
	if ( empty( $_GET['gotcha_code'] ) || empty( $_GET['nonce'] ) ) {
		return null;
	}
	$code     = sanitize_text_field( wp_unslash( $_GET['gotcha_code'] ) );
	$nonce    = sanitize_text_field( wp_unslash( $_GET['nonce'] ) );
	$expected = get_transient( GOTCHA_WC_NONCE );
	delete_transient( GOTCHA_WC_NONCE );
	if ( ! $expected || ! hash_equals( (string) $expected, $nonce ) ) {
		return __( 'This connection link has expired. Press "Connect to GOTCHA" again.', 'gotcha-for-woocommerce' );
	}
	$response = wp_remote_post(
		untrailingslashit( GOTCHA_APP_URL ) . '/api/woocommerce-plugin/exchange',
		array(
			'timeout' => 15,
			'headers' => array( 'Content-Type' => 'application/json' ),
			'body'    => wp_json_encode( array( 'code' => $code, 'siteUrl' => home_url() ) ),
		)
	);
	if ( is_wp_error( $response ) ) {
		return __( 'GOTCHA could not be reached. Try again in a minute.', 'gotcha-for-woocommerce' );
	}
	$status = (int) wp_remote_retrieve_response_code( $response );
	$data   = json_decode( wp_remote_retrieve_body( $response ), true );
	if ( 200 !== $status || empty( $data['widgetId'] ) || empty( $data['siteKey'] ) ) {
		return __( 'The connection did not complete. Press "Connect to GOTCHA" again.', 'gotcha-for-woocommerce' );
	}
	update_option( GOTCHA_WC_OPT_WIDGET, sanitize_text_field( $data['widgetId'] ) );
	update_option( GOTCHA_WC_OPT_KEY, sanitize_text_field( $data['siteKey'] ), false );
	update_option( GOTCHA_WC_OPT_API, esc_url_raw( $data['apiUrl'] ) );
	update_option( GOTCHA_WC_OPT_SCRIPT, esc_url_raw( $data['scriptUrl'] ) );
	update_option( GOTCHA_WC_OPT_WORKSPACE, sanitize_text_field( (string) ( $data['workspaceName'] ?? '' ) ) );
	if ( ! wp_next_scheduled( GOTCHA_WC_CRON ) ) {
		wp_schedule_event( time() + HOUR_IN_SECONDS, 'daily', GOTCHA_WC_CRON );
	}
	return true;
}

function gotcha_wc_settings_page() {
	if ( ! current_user_can( 'manage_woocommerce' ) ) {
		return;
	}
	$notice = null;
	if ( isset( $_POST['gotcha_wc_disconnect'] ) && check_admin_referer( 'gotcha_wc_disconnect' ) ) {
		gotcha_wc_signal( 'disconnected' );
		gotcha_wc_forget();
		$notice = __( 'Disconnected. The chat no longer shows on your store.', 'gotcha-for-woocommerce' );
	}
	$returned = gotcha_wc_handle_return();
	if ( true === $returned ) {
		$notice = __( 'Connected. The chat now shows on your store.', 'gotcha-for-woocommerce' );
	} elseif ( is_string( $returned ) ) {
		$notice = $returned;
	}

	$nonce = wp_generate_password( 32, false );
	set_transient( GOTCHA_WC_NONCE, $nonce, 15 * MINUTE_IN_SECONDS );
	$connect = add_query_arg(
		array(
			'site'   => rawurlencode( home_url() ),
			'return' => rawurlencode( gotcha_wc_settings_url() ),
			'nonce'  => $nonce,
		),
		untrailingslashit( GOTCHA_APP_URL ) . '/v2/connect/woocommerce'
	);
	?>
	<div class="wrap">
		<h1>GOTCHA</h1>
		<?php if ( $notice ) : ?>
			<div class="notice notice-info"><p><?php echo esc_html( $notice ); ?></p></div>
		<?php endif; ?>
		<?php if ( gotcha_wc_connected() ) : ?>
			<p>
				<?php
				/* translators: %s: the GOTCHA workspace's name */
				printf( esc_html__( 'Connected to %s. The chat shows on your store.', 'gotcha-for-woocommerce' ), '<strong>' . esc_html( (string) get_option( GOTCHA_WC_OPT_WORKSPACE ) ) . '</strong>' );
				?>
			</p>
			<p><a class="button button-primary" href="<?php echo esc_url( untrailingslashit( GOTCHA_APP_URL ) . '/v2/settings/channels/website' ); ?>" target="_blank" rel="noopener"><?php esc_html_e( 'Open in GOTCHA', 'gotcha-for-woocommerce' ); ?></a></p>
			<form method="post">
				<?php wp_nonce_field( 'gotcha_wc_disconnect' ); ?>
				<p><button class="button" name="gotcha_wc_disconnect" value="1"><?php esc_html_e( 'Disconnect', 'gotcha-for-woocommerce' ); ?></button></p>
			</form>
		<?php else : ?>
			<p><?php esc_html_e( 'Connect your store to your GOTCHA workspace: your AI employee will answer your customers on your store.', 'gotcha-for-woocommerce' ); ?></p>
			<p><a class="button button-primary" href="<?php echo esc_url( $connect ); ?>"><?php esc_html_e( 'Connect to GOTCHA', 'gotcha-for-woocommerce' ); ?></a></p>
		<?php endif; ?>
	</div>
	<?php
}
