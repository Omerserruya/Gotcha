import { ChannelPlate } from '@/design-system/brand/channel-plate';

/**
 * 02's 34px tile on EVERY channel row - connected, connectable or calls -
 * so the names line up down the list: the channel's mark on the shared plate
 * (`ChannelPlate`), the one every screen draws. Decorative: the channel's
 * name is the row's next words.
 */
export function ChannelTile({ channel }: { readonly channel: string }) {
  return <ChannelPlate channel={channel} size="xl" decorative />;
}
