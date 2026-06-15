import { NotImplementedError } from "../lib/errors";
import { STTProvider, SttSessionContext, SttStream } from "./provider";

export class GoogleCloudSTTProvider implements STTProvider {
  async start(_ctx: SttSessionContext): Promise<SttStream> {
    throw new NotImplementedError("GoogleCloudSTTProvider.start - Phase 3");
  }
}
