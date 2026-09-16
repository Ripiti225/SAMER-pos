import { useMutation } from '@tanstack/react-query';
import { apiBlob } from '../api';

export function BoutonRecu({
  jeton,
  visiteId,
  commandeId,
  numeroTicket,
  className,
  children,
}: {
  jeton: string;
  visiteId: string;
  commandeId: string;
  numeroTicket: number;
  className: string;
  children: React.ReactNode;
}) {
  const telecharger = useMutation({
    mutationFn: () => apiBlob(`/api/client/${jeton}/recu/${commandeId}`, visiteId),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const lien = document.createElement('a');
      lien.href = url;
      lien.download = `recu-${numeroTicket}.pdf`;
      lien.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  });

  return (
    <div>
      <button
        type="button"
        disabled={telecharger.isPending}
        className={className}
        onClick={() => telecharger.mutate()}
      >
        {telecharger.isPending ? 'Préparation du reçu…' : children}
      </button>
      {telecharger.error && <div className="mt-1 text-xs text-alerte">{telecharger.error.message}</div>}
    </div>
  );
}
