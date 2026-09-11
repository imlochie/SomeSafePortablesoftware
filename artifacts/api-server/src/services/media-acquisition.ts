import {
  integrationRegistry,
  type MediaLookupRequest,
  type MissingMediaDiscoveryRequest,
} from "../integrations";
import {
  type AcquisitionJob,
  type AcquisitionProviderId,
} from "./acquisition-jobs";
import { createApprovedAcquisitionJob } from "./acquisition-orchestration";

export interface LookupMediaInput extends MediaLookupRequest {
  providerId?: AcquisitionProviderId | null;
}

export interface DiscoverMissingMediaInput extends MissingMediaDiscoveryRequest {
  providerId?: AcquisitionProviderId | null;
}

export interface RequestMediaAcquisitionInput {
  reviewItemId: number;
  confirmed: true;
}

function preferredProvider(providerId: AcquisitionProviderId | null | undefined) {
  return providerId ?? undefined;
}

export async function lookupMedia(
  input: LookupMediaInput,
  ownerId: string,
) {
  const resolved = await integrationRegistry.resolveCapability(
    "media_lookup",
    ownerId,
    preferredProvider(input.providerId),
  );
  const { providerId, ...request } = input;
  const result = await resolved.execute(request, { ownerId });
  return {
    providerId: resolved.adapter.id,
    records: result.records,
  };
}

export async function discoverMissingMedia(
  input: DiscoverMissingMediaInput,
  ownerId: string,
) {
  const resolved = await integrationRegistry.resolveCapability(
    "missing_media_discovery",
    ownerId,
    preferredProvider(input.providerId),
  );
  const { providerId, ...request } = input;
  const result = await resolved.execute(request, { ownerId });
  return {
    providerId: resolved.adapter.id,
    items: result.items,
  };
}

export async function requestMediaAcquisition(
  input: RequestMediaAcquisitionInput,
  ownerId: string,
): Promise<AcquisitionJob> {
  if (input.confirmed !== true) {
    throw new Error("Explicit confirmation is required before external provider work begins.");
  }
  const { job } = await createApprovedAcquisitionJob(input.reviewItemId, ownerId);
  return job;
}