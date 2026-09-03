import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, Activity, FileCheck2, Library, PlaySquare, Search, RefreshCw, FolderOpen, X } from 'lucide-react';
import {
  useGetArchiveScan,
  useStartArchiveScan,
  useGetArchiveInventory,
  useGetArchiveRecord,
  getGetArchiveScanQueryKey,
  getGetArchiveInventoryQueryKey
} from '@workspace/api-client-react';
// Assuming these are exported from App.tsx. Wait! They are not exported from App.tsx.
