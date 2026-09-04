-- Paiement par articles — miroir cloud multi-restaurant.

-- À FAIRE EN PREMIER. Cette FK, posée par `schema_cloud.sql`, exige que le
-- caissier existe dans `utilisateurs` — table que le site n'alimente plus
-- depuis le 2026-08-16 (sa montée est redirigée vers `utilisateurs_site`).
-- Elle refusait donc toute note payée par un caissier créé sur place, et comme
-- `montee.ts` pousse en ordre strict de `seq` sans rien acquitter en cas
-- d'échec, elle a bloqué LA TOTALITÉ de la montée du 7E le 2026-09-04.
ALTER TABLE notes_split DROP CONSTRAINT IF EXISTS notes_split_payee_par_fk;

ALTER TABLE notes_split
  ADD COLUMN IF NOT EXISTS numero smallint,
  ADD COLUMN IF NOT EXISTS type text DEFAULT 'MONTANT_HISTORIQUE',
  ADD COLUMN IF NOT EXISTS statut text DEFAULT 'A_PAYER',
  ADD COLUMN IF NOT EXISTS sous_total integer,
  ADD COLUMN IF NOT EXISTS promo_montant integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS remise_montant integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fidelite_montant integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS client_fidelite_id uuid,
  ADD COLUMN IF NOT EXISTS fidelite_points integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS service_id uuid,
  ADD COLUMN IF NOT EXISTS payee_par uuid,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS payee_le timestamptz;

WITH numerotees AS (
  SELECT restaurant_id, id,
         row_number() OVER (PARTITION BY restaurant_id, commande_id ORDER BY id)::smallint AS numero
  FROM notes_split
)
UPDATE notes_split n
SET numero = x.numero, sous_total = n.montant
FROM numerotees x
WHERE x.restaurant_id = n.restaurant_id AND x.id = n.id;

UPDATE notes_split n
SET statut = CASE
      WHEN COALESCE(p.total_paye, 0) = 0 THEN 'A_PAYER'
      WHEN COALESCE(p.total_paye, 0) >= n.montant THEN 'PAYEE'
      ELSE 'PARTIELLEMENT_PAYEE'
    END,
    payee_le = CASE WHEN COALESCE(p.total_paye, 0) >= n.montant THEN p.dernier_paiement END,
    service_id = CASE WHEN COALESCE(p.total_paye, 0) >= n.montant THEN p.service_id END,
    payee_par = CASE WHEN COALESCE(p.total_paye, 0) >= n.montant THEN p.encaisse_par END
FROM (
  SELECT restaurant_id, note_id, sum(montant)::integer AS total_paye,
         max(created_at) AS dernier_paiement,
         (array_agg(service_id ORDER BY created_at DESC))[1] AS service_id,
         (array_agg(encaisse_par ORDER BY created_at DESC))[1] AS encaisse_par
  FROM paiements
  WHERE note_id IS NOT NULL
  GROUP BY restaurant_id, note_id
) p
WHERE p.restaurant_id = n.restaurant_id AND p.note_id = n.id;

ALTER TABLE notes_split
  ALTER COLUMN numero SET NOT NULL,
  ALTER COLUMN type SET NOT NULL,
  ALTER COLUMN type SET DEFAULT 'ARTICLES',
  ALTER COLUMN statut SET NOT NULL,
  ALTER COLUMN sous_total SET NOT NULL,
  ALTER COLUMN promo_montant SET NOT NULL,
  ALTER COLUMN remise_montant SET NOT NULL,
  ALTER COLUMN fidelite_montant SET NOT NULL,
  ALTER COLUMN fidelite_points SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS notes_split_commande_numero_unique
  ON notes_split (restaurant_id, commande_id, numero);

ALTER TABLE notes_split
  ADD CONSTRAINT notes_split_numero_check CHECK (numero > 0),
  ADD CONSTRAINT notes_split_type_check CHECK (type IN ('ARTICLES','MONTANT_HISTORIQUE')),
  ADD CONSTRAINT notes_split_statut_check CHECK (statut IN ('A_PAYER','PARTIELLEMENT_PAYEE','PAYEE','ANNULEE')),
  ADD CONSTRAINT notes_split_sous_total_check CHECK (sous_total > 0),
  ADD CONSTRAINT notes_split_reductions_check CHECK (
    promo_montant >= 0 AND remise_montant >= 0 AND fidelite_montant >= 0
  ),
  ADD CONSTRAINT notes_split_commande_fk FOREIGN KEY (restaurant_id, commande_id)
    REFERENCES commandes(restaurant_id, id),
  ADD CONSTRAINT notes_split_client_fk FOREIGN KEY (restaurant_id, client_fidelite_id)
    REFERENCES clients_fidelite(restaurant_id, id),
  ADD CONSTRAINT notes_split_service_fk FOREIGN KEY (restaurant_id, service_id)
    REFERENCES services_caisse(restaurant_id, id);
-- PAS de FK sur `payee_par` : depuis le 2026-08-16 la montée `utilisateurs` est
-- redirigée vers `utilisateurs_site` (REDIRECTION_MONTEE, `_shared/tables.ts`),
-- donc la table `utilisateurs` du cloud ignore les caissiers créés sur place.
-- La FK posée ici refusait leur ligne et bloquait toute la montée du site.

CREATE TABLE IF NOT EXISTS note_split_items (
  restaurant_id UUID NOT NULL,
  id UUID NOT NULL,
  note_id UUID NOT NULL,
  commande_item_id UUID NOT NULL,
  quantite smallint NOT NULL CHECK (quantite > 0),
  montant_brut integer NOT NULL CHECK (montant_brut > 0),
  PRIMARY KEY (restaurant_id, id),
  UNIQUE (restaurant_id, note_id, commande_item_id),
  FOREIGN KEY (restaurant_id, note_id) REFERENCES notes_split(restaurant_id, id),
  FOREIGN KEY (restaurant_id, commande_item_id) REFERENCES commande_items(restaurant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_cloud_note_split_items_note
  ON note_split_items (restaurant_id, note_id);

ALTER TABLE points_fidelite ADD COLUMN IF NOT EXISTS note_id uuid;
ALTER TABLE points_fidelite
  ADD CONSTRAINT points_fidelite_note_fk FOREIGN KEY (restaurant_id, note_id)
    REFERENCES notes_split(restaurant_id, id);

ALTER TABLE note_split_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_split_items FORCE ROW LEVEL SECURITY;
