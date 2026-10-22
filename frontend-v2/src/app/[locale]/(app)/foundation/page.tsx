import { Divider, Metric, MetricRow, Surface } from '@/design-system/primitives/surface/Surface';
import { Inline, Stack } from '@/design-system/primitives/stack/Stack';
import { StatusIndicator } from '@/design-system/primitives/status/StatusIndicator';
import { Text } from '@/design-system/primitives/text/Text';
import { PageContainer } from '@/shell/PageContainer';

/**
 * Foundation reference.
 *
 * Not a product page and not example content: it renders the design system
 * against itself so the layout, the surface stack and the type scale can be
 * judged before any product area is built. Every value shown comes from a
 * token, and there is no business data anywhere on it - the figures are
 * literal zeroes and the labels name what they are.
 *
 * It exists to make the panel judgeable. In the design the work surface is
 * never seen bare; it shows through the gaps between cards, wells and rules,
 * and an empty panel reads far lighter than the same colour broken up. This
 * page shows the stack that does the breaking up.
 *
 * Delete it once the product areas exist.
 */
export default function FoundationPage() {
  return (
    <PageContainer
      title="Foundation"
      description="The surface stack, type scale and layout system, rendered from tokens."
    >
      <Stack gap={8}>
        <Text role="eyebrow" as="h2">
          Surfaces on the panel ground
        </Text>
        <Inline gap={5} align="stretch" wrap>
          <Surface tone="card">
            <Stack gap={3}>
              <Text role="eyebrow" as="p">
                card
              </Text>
              <Text role="bodySm" tone="muted">
                White, bordered. The most forward surface.
              </Text>
            </Stack>
          </Surface>
          <Surface tone="well">
            <Stack gap={3}>
              <Text role="eyebrow" as="p">
                well
              </Text>
              <Text role="bodySm" tone="muted">
                A warm recess for grouped, passive content.
              </Text>
            </Stack>
          </Surface>
          <Surface tone="inset">
            <Stack gap={3}>
              <Text role="eyebrow" as="p">
                inset
              </Text>
              <Text role="bodySm" tone="muted">
                One quiet step up from the ground.
              </Text>
            </Stack>
          </Surface>
        </Inline>
      </Stack>

      <Stack gap={8}>
        <Text role="eyebrow" as="h2">
          Figure strip
        </Text>
        <MetricRow>
          {['Label', 'Label', 'Label', 'Label'].map((label, index) => (
            <Metric key={index}>
              <Text role="micro" tone="subtle" as="span">
                {label}
              </Text>
              <Text role="title" as="span" numeric>
                0
              </Text>
            </Metric>
          ))}
        </MetricRow>
      </Stack>

      <Stack gap={8}>
        <Text role="eyebrow" as="h2">
          Type scale
        </Text>
        <Stack gap={5}>
          <Text role="hero">Hero - 40px</Text>
          <Text role="display">Display - 36px</Text>
          <Text role="title">Title - 30px</Text>
          <Text role="serif">Display serif, the product&rsquo;s voice</Text>
          <Text role="heading">Heading - 16px</Text>
          <Text role="body" tone="muted">
            Body - 14.5px, the size most reading happens at.
          </Text>
          <Text role="bodySm" tone="muted">
            Body small - 13px.
          </Text>
          <Text role="caption" tone="subtle">
            Caption - 11.5px.
          </Text>
        </Stack>
      </Stack>

      <Stack gap={8}>
        <Text role="eyebrow" as="h2">
          Signals
        </Text>
        <Inline gap={4} wrap>
          <StatusIndicator tone="ai">Handled by AI</StatusIndicator>
          <StatusIndicator tone="done">Done</StatusIndicator>
          <StatusIndicator tone="waiting">Waiting</StatusIndicator>
          <StatusIndicator tone="neutral">Neutral</StatusIndicator>
        </Inline>
      </Stack>

      <Divider />

      <Text role="caption" tone="subtle">
        Foundation reference. No product data appears on this page.
      </Text>
    </PageContainer>
  );
}
