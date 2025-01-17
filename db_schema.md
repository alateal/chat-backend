# Database Schema Description

## Tables and Fields

### **user_status**
- **Purpose**: Tracks the online status of users.
- **Fields**:
  - `id` (int8): Primary key, uniquely identifies the record.
  - `is_online` (bool): Indicates if a user is online (`true`) or offline (`false`).
  - `user_id` (text): Foreign key linking to the user.
---

### **messages**
- **Purpose**: Stores messages exchanged between users in conversations or channels.
- **Fields**:
  - `id` (int8): Primary key, uniquely identifies the message.
  - `created_at` (timestamptz): Timestamp indicating when the message was created.
  - `content` (text): The content of the message.
  - `created_by` (text): User ID of the message creator.
  - `reactions` (jsonb): JSON object representing reactions to the message.
  - `conversation_id` (int8): Foreign key referencing `conversations.id`.
  - `file_attachments` (jsonb): JSON object storing details of file attachments.
  - `parent_message_id` (int8): Foreign key referencing `messages.id`.
  - `audio_url` (text): URL of the audio file associated with the message.
---

---

### **conversations**
- **Purpose**: Represents private conversations or direct messages between users.
- **Fields**:
  - `id` (int8): Primary key, uniquely identifies the conversation.
  - `created_at` (timestamptz): Timestamp indicating when the conversation was created.
  - `name` (text): The name of the conversation.
  - `created_by` (text): User ID of the conversation creator.

---

### **conversation_members**
- **Purpose**: Tracks members of a conversation.
- **Fields**:
  - `user_id` (text): User ID of the participant.
  - `created_at` (timestamptz): Timestamp indicating when the user joined the conversation.
  - `conversation_id` (int8): Foreign key referencing `conversations.id`.

---

## Relationships
1. **messages.conversation_id** → Foreign key referencing **conversations.id**.
2. **conversation_members.conversation_id** → Foreign key referencing **conversations.id**.

---

This schema supports a system that allows:
- Tracking user online statuses.
- Messaging functionality with support for file attachments and reactions.
- Communication within channels or private conversations (DMs).
- User membership in conversations.
