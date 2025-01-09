# Database Schema Description

## Tables and Relationships

### **messages**
- **Purpose**: Stores all messages exchanged in channels or conversations.
- **Fields**:
  - `id` (int8): Primary key, uniquely identifies each message.
  - `created_at` (timestamptz): The timestamp when the message was created.
  - `content` (text): The text content of the message.
  - `created_by` (text): The user ID of the creator of the message.
  - `channel_id` (int8): Foreign key linking the message to a specific channel (references `channels.id`).
  - `reactions` (jsonb): JSON object storing reactions to the message.
  - `conversation_id` (int8): Foreign key linking the message to a specific conversation (references `conversations.id`).

---

### **channels**
- **Purpose**: Represents communication channels within the application.
- **Fields**:
  - `id` (int8): Primary key, uniquely identifies each channel.
  - `created_at` (timestamptz): The timestamp when the channel was created.
  - `name` (text): The name of the channel.
  - `created_by` (text): The user ID of the channel creator.

---

### **conversations**
- **Purpose**: Represents direct messages (DMs) or group conversations.
- **Fields**:
  - `id` (int8): Primary key, uniquely identifies each conversation.
  - `created_at` (timestamptz): The timestamp when the conversation was created.

---

### **conversation_members**
- **Purpose**: Tracks the participants of a conversation.
- **Fields**:
  - `user_id` (text): User ID of a participant in the conversation.
  - `created_at` (timestamptz): The timestamp when the user joined the conversation.
  - `conversation_id` (int8): Foreign key linking the participant to a specific conversation (references `conversations.id`).

---

### **user_status**
- **Purpose**: Tracks the online status of users.
- **Fields**:
  - `user_id` (int8): Primary key, uniquely identifies the user.
  - `is_online` (bool): Boolean field indicating if the user is online (`true`) or offline (`false`).

---

## Relationships
1. **messages.channel_id** → Foreign key referencing **channels.id**.
2. **messages.conversation_id** → Foreign key referencing **conversations.id**.
3. **conversation_members.conversation_id** → Foreign key referencing **conversations.id**.

This schema ensures clear separation between channels, conversations, and their participants, while also supporting user status tracking and message reactions.
