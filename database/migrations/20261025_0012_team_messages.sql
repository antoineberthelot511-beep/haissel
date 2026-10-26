-- Migration : messagerie entre chaque membre et l'équipe HAISSEL
--
-- Réutilise les tables conversations et messages du schéma de base (jamais
-- utilisées jusqu'ici). Une conversation d'équipe = une ligne de
-- conversations avec member_id renseigné ; il n'y a PAS de messages entre
-- membres. Les anciennes lignes éventuelles (member_id NULL) sont ignorées.
--
-- Rétention : la conversation (et ses messages, par cascade) est supprimée
-- 12 mois après last_message_at (voir retention.service.js).
--
-- Non destructive et réexécutable.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS member_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_member ON conversations (member_id) WHERE member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations (last_message_at);

-- from_team : message écrit par un ADMIN au nom de l'équipe. is_read : lu
-- par le destinataire (le membre pour un message de l'équipe, l'équipe sinon).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS from_team BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_sender_time ON messages (sender_id, created_at);
