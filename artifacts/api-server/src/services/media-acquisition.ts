import {
  integrationRegistry,
  type MediaLookupRequest,
  type MissingMediaDiscoveryRequest,
} from "../integrations";
import {
  createAcquisitionJob,
  type AcquisitionJob,
  type AcquisitionProviderId,
  type CreateAcquisitionJobInput,
} from "./acquisition-jobs";

export type ArchiveIdentity = Record<string, unknown>;
export type AcquisitionPolicyDecision = Record<string, unknown>;

export interface LookupMediaInput extends MediaLookupRequest {
  providerId?: AcquisitionProviderId | null;
}

export interface DiscoverMissingMediaInput extends MissingMediaDiscoveryRequest {
  providerId?: AcquisitionProviderId | null;
}

export interface RequestMediaAcquisitionInput extends CreateAcquisitionJobInput {
  archiveIdentity?: ArchiveIdentity | null;
  policyDecision?: AcquisitionPolicyDecision | null;
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
  const archiveIdentity = input.archiveIdentity ?? null;
  const policyDecision = input.policyDecision ?? null;
  const metadata = {
    ...(input.metadata ?? {}),
    ...(archiveIdentity === null ? {} : { archiveIdentity }),
    ...(policyDecision === null ? {} : { policyDecision }),
  };
  const job = await createAcquisitionJob(
    {
      ...input,
      metadata,
      start: true,
    },
    ownerId,
  );
  if (!job) throw new Error("Acquisition job could not be read after creation.");
  return job;
}