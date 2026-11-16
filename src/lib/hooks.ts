import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, ApiError } from './api'

export function useApi<T>(key: string, path: string, intervalMs = 4000) {
  return useQuery<T, ApiError>({
    queryKey: [key, path],
    queryFn: () => api<T>(path),
    refetchInterval: intervalMs,
    retry: (count, err) => err.status !== 401 && count < 2,
  })
}

/** POST/PATCH helper that reports errors as toasts and refreshes every query on success. */
export function useAction<TBody = unknown, TRes = unknown>(path: string | ((b: TBody) => string), method = 'POST', success?: string) {
  const qc = useQueryClient()
  return useMutation<TRes, ApiError, TBody>({
    mutationFn: (body) => api<TRes>(typeof path === 'function' ? path(body) : path, { method, body }),
    onSuccess: () => {
      if (success) toast.success(success)
      void qc.invalidateQueries()
    },
    onError: (e) => toast.error(e.message),
  })
}
