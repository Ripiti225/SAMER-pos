ALTER TABLE restaurant DROP CONSTRAINT restaurant_marque_check;
--> statement-breakpoint
ALTER TABLE restaurant ADD CONSTRAINT restaurant_marque_check
  CHECK (marque IN ('SAMER','AL_KAYAN','A_LA_BRAISE'));
