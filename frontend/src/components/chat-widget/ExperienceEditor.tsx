"use client";

import { useMemo } from "react";
import { Card, Field, Toggle, Select, ColorInput, MediaField, SoundPreview } from "./primitives";
import { heroHeightWarning, WELCOME_FALLBACK, HERO_FALLBACK } from "@/lib/shopify-chat-ux-client";

/**
 * The chat widget's experience editor.
 *
 * Every section here edits the SHARED experience block — launcher, hero,
 * welcome screen, proactive teaser, sounds, behaviour — which is the same
 * on the Shopify storefront and on a tenant's own website. Nothing in it
 * is about commerce, so nothing in it belongs to one channel.
 *
 * These were sections inside the Shopify channel's settings page. The
 * website widget had a smaller imitation with four fields, and the two
 * drifted exactly as you would expect. One editor now, used twice.
 *
 * Each section takes the `ux` block and a `patch(path, value)` that writes
 * back with a full `ux.` path, so a caller can keep whatever draft shape
 * it likes around it.
 */

export interface SectionProps {
  ux: any;
  patch: (path: string, value: unknown) => void;
  t: (key: string, vars?: Record<string, string>) => string;
}

/** The sections that are the same wherever the widget is embedded. */
export const EXPERIENCE_SECTIONS = ["welcome", "launcher", "proactive", "sounds", "behavior"] as const;
export type ExperienceSection = (typeof EXPERIENCE_SECTIONS)[number];


export function WelcomeSection({ ux, patch, t }: SectionProps) {
  // The server normalizes on every read and write, so a saved widget
  // arrives canonical; these cover a widget that has never been saved.
  const welcome = useMemo(() => ({ ...WELCOME_FALLBACK, ...(ux?.welcome ?? {}) }), [ux?.welcome]);
  const hero = useMemo(() => ({ ...HERO_FALLBACK, ...(ux?.hero ?? {}) }), [ux?.hero]);
  const heroFit = useMemo(
    () => heroHeightWarning({ configured: hero.height, panelHeight: 640, isMobile: false }),
    [hero.height],
  );

  return (
      <>
        <Card title={t("shopifyChat.section.welcome")} hint={t("shopifyChat.welcomeSectionHint")}>
          <Field label={t("shopifyChat.assistantName")} hint={t("shopifyChat.assistantNameHint")}>
            <input maxLength={40} value={welcome.assistantName}
              onChange={(e) => patch("ux.welcome.assistantName", e.target.value)}
              className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg" />
          </Field>
          <Field label={t("shopifyChat.headline")}>
            <input maxLength={60} value={welcome.title}
              onChange={(e) => patch("ux.welcome.title", e.target.value)}
              className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg" />
          </Field>
          <Field label={t("shopifyChat.subline")}>
            <textarea rows={3} maxLength={200} value={welcome.subtitle}
              onChange={(e) => patch("ux.welcome.subtitle", e.target.value)}
              className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg" />
          </Field>
          <Field label={t("shopifyChat.textAlign")}>
            <Select value={welcome.textAlign} onChange={(v) => patch("ux.welcome.textAlign", v)}
              options={[
                { value: "center", label: t("shopifyChat.alignCenter") },
                { value: "start", label: t("shopifyChat.alignStart") },
              ]} />
          </Field>
        </Card>

        <Card title={t("shopifyChat.avatarCard")} hint={t("shopifyChat.avatarCardHint")}>
          <MediaField label={t("shopifyChat.avatarUrl")} slot="image"
            value={welcome.avatarUrl} onChange={(v) => patch("ux.welcome.avatarUrl", v)} t={t} />
          <div className="grid grid-cols-2 gap-3">
            <Field label={`${t("shopifyChat.heroAvatarSize")}: ${welcome.avatarSize}px`}>
              <input type="range" min={40} max={96} value={welcome.avatarSize}
                onChange={(e) => patch("ux.welcome.avatarSize", Number(e.target.value))} className="w-full" />
            </Field>
            <Field label={`${t("shopifyChat.heroOverlap")}: ${welcome.avatarOverlap}px`}
              hint={t("shopifyChat.heroOverlapHint")}>
              <input type="range" min={0} max={60} value={welcome.avatarOverlap}
                onChange={(e) => patch("ux.welcome.avatarOverlap", Number(e.target.value))} className="w-full" />
            </Field>
          </div>
        </Card>

        <Card title={t("shopifyChat.section.hero")} hint={t("shopifyChat.heroHint")}>
          <Field label={t("shopifyChat.heroMediaType")}>
            <Select value={hero.mediaType} onChange={(v) => patch("ux.hero.mediaType", v)}
              options={["none", "image", "gif", "video"].map((v) => ({ value: v, label: t(`shopifyChat.media.${v}`) }))} />
          </Field>
          {hero.mediaType !== "none" && (
            <>
              <MediaField label={t("shopifyChat.heroMediaUrl")}
                slot={hero.mediaType === "video" ? "video" : "image"}
                value={hero.mediaUrl} onChange={(v) => patch("ux.hero.mediaUrl", v)} t={t} />
              {hero.mediaType === "video" && (
                <MediaField label={t("shopifyChat.heroPoster")} slot="image" hint={t("shopifyChat.heroPosterHint")}
                  value={hero.posterUrl} onChange={(v) => patch("ux.hero.posterUrl", v)} t={t} />
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label={`${t("shopifyChat.heroHeight")}: ${hero.height}px`}>
                  <input type="range" min={90} max={220} value={hero.height}
                    onChange={(e) => patch("ux.hero.height", Number(e.target.value))} className="w-full" />
                </Field>
                <Field label={`${t("shopifyChat.heroMobileHeight")}: ${hero.mobileHeight}px`}>
                  <input type="range" min={80} max={180} value={hero.mobileHeight}
                    onChange={(e) => patch("ux.hero.mobileHeight", Number(e.target.value))} className="w-full" />
                </Field>
                <Field label={`${t("shopifyChat.heroFade")}: ${hero.fadeStrength}%`}>
                  <input type="range" min={0} max={100} value={hero.fadeStrength}
                    onChange={(e) => patch("ux.hero.fadeStrength", Number(e.target.value))} className="w-full" />
                </Field>
                <Field label={`${t("shopifyChat.heroOverlay")}: ${hero.overlayStrength}%`}>
                  <input type="range" min={0} max={100} value={hero.overlayStrength}
                    onChange={(e) => patch("ux.hero.overlayStrength", Number(e.target.value))} className="w-full" />
                </Field>
              </div>
              {/* The panel has the last word on height. Say so here
                  rather than letting the merchant wonder why their
                  220 looks like 180 on the storefront. */}
              {heroFit !== "ok" && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  {t(heroFit === "dropped" ? "shopifyChat.heroDropped" : "shopifyChat.heroTight")}
                </p>
              )}
              {hero.mediaType === "video" && (
                <>
                  <Toggle label={t("shopifyChat.videoLoop")} checked={hero.videoLoop !== false}
                    onChange={(v) => patch("ux.hero.videoLoop", v)} />
                  <Toggle label={t("shopifyChat.videoAutoplay")} hint={t("shopifyChat.videoAutoplayHint")}
                    checked={hero.videoAutoplay !== false}
                    onChange={(v) => patch("ux.hero.videoAutoplay", v)} />
                </>
              )}
            </>
          )}
        </Card>

        <Card title={t("shopifyChat.section.questions")} hint={t("shopifyChat.questionsHint")}>
          {welcome.suggestedQuestions.map((q: string, i: number) => (
            <div key={i} className="flex gap-2">
              <input maxLength={80} value={q}
                onChange={(e) => {
                  const next = [...welcome.suggestedQuestions];
                  next[i] = e.target.value;
                  patch("ux.welcome.suggestedQuestions", next);
                }}
                className="flex-1 text-sm px-3 py-2 border border-gray-200 rounded-lg" />
              <button type="button"
                onClick={() => patch("ux.welcome.suggestedQuestions", welcome.suggestedQuestions.filter((_: string, j: number) => j !== i))}
                aria-label={t("common.delete")}
                className="px-3 py-2 text-sm text-gray-400 hover:text-red-600 rounded-lg">
                ✕
              </button>
            </div>
          ))}
          {welcome.suggestedQuestions.length < 5 && (
            <button type="button"
              onClick={() => patch("ux.welcome.suggestedQuestions", [...welcome.suggestedQuestions, ""])}
              className="text-sm text-primary-600 hover:text-primary-700">
              + {t("shopifyChat.addQuestion")}
            </button>
          )}
        </Card>
      </>
  );
}

export function LauncherSection({ ux, patch, t }: SectionProps) {
  return (
      <Card title={t("shopifyChat.section.launcher")} hint={t("shopifyChat.launcherHint")}>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("shopifyChat.launcherShape")}>
            <Select
              value={ux?.launcher?.shape ?? "circle"}
              onChange={(v) => patch("ux.launcher.shape", v)}
              options={["circle", "rounded", "pill"].map((v) => ({ value: v, label: t(`shopifyChat.shape.${v}`) }))}
            />
          </Field>
          <Field label={`${t("shopifyChat.launcherSize")}: ${ux?.launcher?.size ?? 60}px`}>
            <input type="range" min={44} max={96} value={ux?.launcher?.size ?? 60}
              onChange={(e) => patch("ux.launcher.size", Number(e.target.value))} className="w-full" />
          </Field>
          <Field label={t("shopifyChat.launcherBg")}>
            <ColorInput value={ux?.launcher?.backgroundColor ?? "#111827"} onChange={(v) => patch("ux.launcher.backgroundColor", v)} />
          </Field>
          <Field label={t("shopifyChat.launcherFg")}>
            <ColorInput value={ux?.launcher?.iconColor ?? "#ffffff"} onChange={(v) => patch("ux.launcher.iconColor", v)} />
          </Field>
          <Field label={t("shopifyChat.position")}>
            <Select value={ux?.launcher?.position ?? "right"} onChange={(v) => patch("ux.launcher.position", v)}
              options={[{ value: "right", label: t("shopifyChat.right") }, { value: "left", label: t("shopifyChat.left") }]} />
          </Field>
          <Field label={t("shopifyChat.mobilePosition")}>
            <Select value={ux?.launcher?.mobilePosition ?? "right"} onChange={(v) => patch("ux.launcher.mobilePosition", v)}
              options={[{ value: "right", label: t("shopifyChat.right") }, { value: "left", label: t("shopifyChat.left") }]} />
          </Field>
          <Field label={`${t("shopifyChat.offsetBottom")}: ${ux?.launcher?.offsetBottom ?? 20}px`}>
            <input type="range" min={0} max={120} value={ux?.launcher?.offsetBottom ?? 20}
              onChange={(e) => patch("ux.launcher.offsetBottom", Number(e.target.value))} className="w-full" />
          </Field>
          <Field label={`${t("shopifyChat.offsetSide")}: ${ux?.launcher?.offsetSide ?? 20}px`}>
            <input type="range" min={0} max={120} value={ux?.launcher?.offsetSide ?? 20}
              onChange={(e) => patch("ux.launcher.offsetSide", Number(e.target.value))} className="w-full" />
          </Field>
        </div>
        <Field label={`${t("shopifyChat.shadow")}: ${ux?.launcher?.shadow ?? 2}`}>
          <input type="range" min={0} max={3} value={ux?.launcher?.shadow ?? 2}
            onChange={(e) => patch("ux.launcher.shadow", Number(e.target.value))} className="w-full" />
        </Field>
        <Field label={t("shopifyChat.launcherIcon")}>
          <Select value={ux?.launcher?.icon ?? "chat"} onChange={(v) => patch("ux.launcher.icon", v)}
            options={["chat", "sparkle", "bag", "question", "custom"].map((v) => ({ value: v, label: t(`shopifyChat.icon.${v}`) }))} />
        </Field>
        {ux?.launcher?.icon === "custom" && (
          <Field label={t("shopifyChat.launcherIconUrl")} hint={t("shopifyChat.mediaHint")}>
            <input type="url" value={ux?.launcher?.iconUrl ?? ""}
              onChange={(e) => patch("ux.launcher.iconUrl", e.target.value || null)}
              className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg" />
          </Field>
        )}
        <Toggle label={t("shopifyChat.showLabel")} checked={!!ux?.launcher?.showLabel}
          onChange={(v) => patch("ux.launcher.showLabel", v)} />
        {ux?.launcher?.showLabel && (
          <Field label={t("shopifyChat.launcherLabel")}>
            <input maxLength={24} value={ux?.launcher?.label ?? ""}
              onChange={(e) => patch("ux.launcher.label", e.target.value)}
              placeholder={t("shopifyChat.launcherLabelPlaceholder")}
              className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg" />
          </Field>
        )}
        <Toggle label={t("shopifyChat.showBorder")} checked={!!ux?.launcher?.showBorder}
          onChange={(v) => patch("ux.launcher.showBorder", v)} />
        <Toggle label={t("shopifyChat.showUnreadBadge")} checked={ux?.launcher?.showUnreadBadge !== false}
          onChange={(v) => patch("ux.launcher.showUnreadBadge", v)} />
      </Card>
  );
}

export function ProactiveSection({ ux, patch, t }: SectionProps) {
  return (
      <Card title={t("shopifyChat.section.proactive")} hint={t("shopifyChat.proactiveHint")}>
        <Toggle label={t("shopifyChat.proactiveEnabled")} hint={t("shopifyChat.proactiveEnabledHint")}
          checked={!!ux?.proactive?.enabled} onChange={(v) => patch("ux.proactive.enabled", v)} />
        {ux?.proactive?.enabled && (
          <>
            <Field label={t("shopifyChat.triggerLabel")}>
              <Select value={ux?.proactive?.trigger ?? "time_on_page"} onChange={(v) => patch("ux.proactive.trigger", v)}
                options={["time_on_page", "page_views", "scroll_depth", "exit_intent", "product_page", "cart_page", "inactivity", "custom_event"]
                  .map((v) => ({ value: v, label: t(`shopifyChat.trigger.${v}`) }))} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={`${t("shopifyChat.delay")}: ${ux?.proactive?.delaySeconds ?? 15}s`}>
                <input type="range" min={3} max={120} value={ux?.proactive?.delaySeconds ?? 15}
                  onChange={(e) => patch("ux.proactive.delaySeconds", Number(e.target.value))} className="w-full" />
              </Field>
              <Field label={`${t("shopifyChat.mobileDelay")}: ${ux?.proactive?.mobileDelaySeconds ?? 25}s`}>
                <input type="range" min={3} max={120} value={ux?.proactive?.mobileDelaySeconds ?? 25}
                  onChange={(e) => patch("ux.proactive.mobileDelaySeconds", Number(e.target.value))} className="w-full" />
              </Field>
            </div>
            <Field label={t("shopifyChat.teaserTitle")}>
              <input maxLength={60} value={ux?.proactive?.title ?? ""}
                onChange={(e) => patch("ux.proactive.title", e.target.value)}
                className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg" />
            </Field>
            <Field label={t("shopifyChat.teaserMessage")}>
              <textarea rows={2} maxLength={200} value={ux?.proactive?.message ?? ""}
                onChange={(e) => patch("ux.proactive.message", e.target.value)}
                className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg" />
            </Field>
            <Field label={t("shopifyChat.teaserAction")}>
              <input maxLength={30} value={ux?.proactive?.actionLabel ?? ""}
                onChange={(e) => patch("ux.proactive.actionLabel", e.target.value)}
                className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("shopifyChat.maxPerSession")}>
                <Select value={String(ux?.proactive?.maxPerSession ?? 1)} onChange={(v) => patch("ux.proactive.maxPerSession", Number(v))}
                  options={[1, 2, 3].map((n) => ({ value: String(n), label: String(n) }))} />
              </Field>
              <Field label={`${t("shopifyChat.cooldown")}: ${ux?.proactive?.cooldownHours ?? 24}h`}>
                <input type="range" min={1} max={168} value={ux?.proactive?.cooldownHours ?? 24}
                  onChange={(e) => patch("ux.proactive.cooldownHours", Number(e.target.value))} className="w-full" />
              </Field>
            </div>
            <Toggle label={t("shopifyChat.autoOpen")} hint={t("shopifyChat.autoOpenHint")}
              checked={!!ux?.proactive?.autoOpen} onChange={(v) => patch("ux.proactive.autoOpen", v)} />
            <Toggle label={t("shopifyChat.desktopEnabled")} checked={ux?.proactive?.desktopEnabled !== false}
              onChange={(v) => patch("ux.proactive.desktopEnabled", v)} />
            <Toggle label={t("shopifyChat.mobileEnabled")} checked={ux?.proactive?.mobileEnabled !== false}
              onChange={(v) => patch("ux.proactive.mobileEnabled", v)} />
            <Toggle label={t("shopifyChat.respectHours")} checked={ux?.proactive?.respectBusinessHours !== false}
              onChange={(v) => patch("ux.proactive.respectBusinessHours", v)} />
          </>
        )}
      </Card>
  );
}

export function SoundsSection({ ux, patch, t }: SectionProps) {
  return (
      <Card title={t("shopifyChat.section.sounds")} hint={t("shopifyChat.soundsHint")}>
        <Toggle label={t("shopifyChat.soundsEnabled")} checked={!!ux?.sounds?.enabled}
          onChange={(v) => patch("ux.sounds.enabled", v)} />
        {ux?.sounds?.enabled && (
          <>
            <Field label={t("shopifyChat.soundPack")}>
              <Select value={ux?.sounds?.pack ?? "subtle"} onChange={(v) => patch("ux.sounds.pack", v)}
                options={["subtle", "classic"].map((v) => ({ value: v, label: t(`shopifyChat.pack.${v}`) }))} />
            </Field>
            <Field label={`${t("shopifyChat.volume")}: ${ux?.sounds?.volume ?? 40}%`}>
              <input type="range" min={0} max={100} value={ux?.sounds?.volume ?? 40}
                onChange={(e) => patch("ux.sounds.volume", Number(e.target.value))} className="w-full" />
            </Field>
            <SoundPreview pack={ux?.sounds?.pack ?? "subtle"} volume={ux?.sounds?.volume ?? 40} t={t} />
            <Toggle label={t("shopifyChat.soundOutgoing")} checked={ux?.sounds?.outgoing !== false}
              onChange={(v) => patch("ux.sounds.outgoing", v)} />
            <Toggle label={t("shopifyChat.soundIncomingAi")} checked={ux?.sounds?.incomingAi !== false}
              onChange={(v) => patch("ux.sounds.incomingAi", v)} />
            <Toggle label={t("shopifyChat.soundIncomingHuman")} checked={ux?.sounds?.incomingHuman !== false}
              onChange={(v) => patch("ux.sounds.incomingHuman", v)} />
            <Toggle label={t("shopifyChat.soundProactive")} checked={!!ux?.sounds?.proactive}
              onChange={(v) => patch("ux.sounds.proactive", v)} />
            <Toggle label={t("shopifyChat.soundWhenClosed")} checked={ux?.sounds?.playWhenClosed !== false}
              onChange={(v) => patch("ux.sounds.playWhenClosed", v)} />
            <Toggle label={t("shopifyChat.soundWhenTabActive")} checked={ux?.sounds?.playWhenTabActive !== false}
              onChange={(v) => patch("ux.sounds.playWhenTabActive", v)} />
          </>
        )}
      </Card>
  );
}

export function BehaviorSection({ ux, patch, t }: SectionProps) {
  return (
      <Card title={t("shopifyChat.section.behavior")}>
        <Toggle label={t("shopifyChat.openOnLoad")} hint={t("shopifyChat.openOnLoadHint")}
          checked={!!ux?.behavior?.openOnLoad} onChange={(v) => patch("ux.behavior.openOnLoad", v)} />
        <Toggle label={t("shopifyChat.closeOnOutsideClick")} checked={!!ux?.behavior?.closeOnOutsideClick}
          onChange={(v) => patch("ux.behavior.closeOnOutsideClick", v)} />
        <Toggle label={t("shopifyChat.rememberOpenState")} checked={ux?.behavior?.rememberOpenState !== false}
          onChange={(v) => patch("ux.behavior.rememberOpenState", v)} />
        <Toggle label={t("shopifyChat.mobileFullScreen")} checked={ux?.behavior?.mobileFullScreen !== false}
          onChange={(v) => patch("ux.behavior.mobileFullScreen", v)} />
        <Toggle label={t("shopifyChat.keepHeaderMedia")} hint={t("shopifyChat.keepHeaderMediaHint")}
          checked={!!ux?.behavior?.keepHeaderMedia} onChange={(v) => patch("ux.behavior.keepHeaderMedia", v)} />
      </Card>
  );
}

/** Render a section by name. */
export function ExperienceSection({ section, ...props }: SectionProps & { section: ExperienceSection }) {
  switch (section) {
    case "welcome": return <WelcomeSection {...props} />;
    case "launcher": return <LauncherSection {...props} />;
    case "proactive": return <ProactiveSection {...props} />;
    case "sounds": return <SoundsSection {...props} />;
    case "behavior": return <BehaviorSection {...props} />;
    default: return null;
  }
}
