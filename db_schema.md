# Database Schema for Slack Clone

## 1. Messages Table
| Column Name  | Data Type  | Notes                           |
|--------------|------------|---------------------------------|
| id           | int8       | Primary Key                    |
| created_at   | timestamptz| Timestamp when message was created |
| content      | text       | Content of the message         |
| created_by   | text       | User ID of the message creator |
| channel_id   | int8       | Foreign Key referencing `channels.id` |
| reactions    | jsonb      | Reactions to the message       |

---

## 2. Channels Table
| Column Name  | Data Type  | Notes                           |
|--------------|------------|---------------------------------|
| id           | int8       | Primary Key                    |
| created_at   | timestamptz| Timestamp when channel was created |
| name         | text       | Name of the channel            |
| created_by   | text       | User ID of the channel creator |

---

## 3. Conversations Table
| Column Name  | Data Type  | Notes                           |
|--------------|------------|---------------------------------|
| id           | int8       | Primary Key                    |
| created_at   | timestamptz| Timestamp when conversation was created |

---

## 4. Conversation Members Table
| Column Name      | Data Type  | Notes                           |
|------------------|------------|---------------------------------|
| user_id          | text       | User ID of the member          |
| created_at       | timestamptz| Timestamp when member joined   |
| conversation_id  | int8       | Foreign Key referencing `conversations.id` |

---

## Relationships
1. **Messages** → **Channels**: Each message belongs to a channel (one-to-many relationship).
2. **Conversation Members** → **Conversations**: Many users can belong to one conversation (many-to-one relationship).
