# Campus Notifications Microservice Design

## Stage 1: API Design & Real-time Mechanism

So the main actions a notification platform needs to support are:
1. Fetching notifications for the logged-in user
2. Marking a notification (or all of them) as read

### REST API Endpoints

**GET /api/v1/notifications** — Fetch all notifications for a student

Headers:
```
Authorization: Bearer <token>
Content-Type: application/json
```

Response (200):
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "type": "Placement",
      "message": "CSX Corporation hiring",
      "isRead": false,
      "createdAt": "2026-04-22T17:51:30Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 45
  }
}
```

**PATCH /api/v1/notifications/:id/read** — Mark one notification as read

Response (200):
```json
{
  "success": true,
  "message": "Notification marked as read."
}
```

### Real-time Mechanism

For real-time delivery I'd go with **Server-Sent Events (SSE)** instead of WebSockets. The reason is that notifications only flow in one direction — from the server to the client. SSE works over plain HTTP, supports auto-reconnection out of the box, and is simpler to set up compared to WebSockets which are better suited for two-way communication like chat apps.

---

## Stage 2: Database Design

### Why PostgreSQL?

I'm going with PostgreSQL here. Notifications have a pretty fixed structure — every notification has a type, a message, a student it belongs to, and a timestamp. This kind of data fits naturally into a relational model. Plus, we need to frequently filter by student_id and is_read, and sort by created_at — relational DBs handle this really well with proper indexes.

### Schema

```sql
CREATE TYPE notification_type AS ENUM ('Event', 'Result', 'Placement');

CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id VARCHAR(50) NOT NULL,
    type notification_type NOT NULL,
    message TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_student_unread ON notifications(student_id, is_read, created_at DESC);
```

### What happens when data grows?

As we get more and more notifications (millions of rows), things will start slowing down. Two things we can do:

- **Partition the table by date** — say monthly partitions. Most users only care about recent notifications anyway, so queries will only scan the latest partition instead of the whole table.
- **Archive old data** — notifications older than 6 months can be moved to cold storage (like S3). This keeps the main table lean.

### Sample Query

```sql
SELECT id, type, message, created_at 
FROM notifications 
WHERE student_id = 'user_123' AND is_read = FALSE 
ORDER BY created_at DESC 
LIMIT 20 OFFSET 0;
```

---

## Stage 3: Query Optimization

The original query:
```sql
SELECT * FROM notifications 
WHERE studentID = 1042 AND isRead = false 
ORDER BY createdAt DESC;
```

### Why is it slow?

With 5 million rows and no proper index, the DB is basically doing a full table scan — going through every single row to find the ones matching studentID = 1042. Then it has to sort all those results by createdAt in memory. Thats super expensive.

Also `SELECT *` is pulling every column even if we dont need them all, which wastes memory and disk I/O.

### Should we add indexes on every column?

No, definitely not. Every index needs to be updated on every INSERT, UPDATE, and DELETE. So if we index every column, our write performance tanks. Also indexes take up disk space. The smart approach is to only create indexes that match our actual query patterns — in this case, a composite index on (studentID, isRead, createdAt) would cover the WHERE and ORDER BY clause perfectly.

### Query to find students with Placement notifications in last 7 days

```sql
SELECT DISTINCT student_id 
FROM notifications 
WHERE type = 'Placement' 
  AND created_at >= NOW() - INTERVAL '7 days';
```

A composite index on `(type, created_at)` would make this fast.

---

## Stage 4: Performance

The problem is that the DB gets hammered on every single page load because notifications are being fetched every time.

### Option 1: Redis Cache

We can cache each student's recent notifications in Redis. When a page loads, we check Redis first — if the data is there, we return it instantly without touching the DB at all.

The downside is cache invalidation. When a new notification comes in or when someone marks one as read, we need to update or clear the cache. If the cache gets out of sync with the DB, users see stale data. But honestly for notifications, being a few seconds stale is totally acceptable.

### Option 2: Pagination

Instead of loading ALL notifications on page load, just load the first 10-20 using cursor-based pagination. This doesn't stop the DB from being hit, but each hit is much lighter.

### What I'd actually do

Combine both. Cache the unread count in Redis (since thats what shows up in the navbar badge and gets hit on literally every page load). Only query the actual DB with pagination when the user explicitly clicks to open the notification panel. This way the DB only gets queried when someone actually wants to read their notifications.

---

## Stage 5: Reliability & Fast Delivery

The original pseudocode:
```
function notify_all(student_ids: array, message: string):
  for student_id in student_ids:
    send_email(student_id, message)
    save_to_db(student_id, message)
    push_to_app(student_id, message)
```

### What's wrong with this?

A lot actually:

1. Its completely synchronous — for 50,000 students, each iteration waits for the email API call, then the DB insert, then the push notification. This would take forever and probably timeout.

2. The big issue with the 200 student failure — if send_email crashes at student #25,000, the loop dies. The remaining 25,000 students get nothing. And we cant just restart the loop because then the first 25,000 get duplicate emails. There's no way to safely resume.

3. Saving to DB and sending an email shouldn't be coupled together. DB inserts are fast (local operation), email sending is slow and unreliable (external API call that can fail, get rate-limited, etc).

### How to fix it: Message Queues

The idea is to split this into two parts. The API handler just does the fast stuff (DB inserts) and pushes tasks to a message queue. Then separate worker processes pick up tasks from the queue and handle the slow stuff (emails, push notifications) independently.

If a worker fails on one email, only that task gets retried — not the whole batch.

```
// API Handler — runs in milliseconds
function notify_all(student_ids, message):
  save_bulk_to_db(student_ids, message)
  
  for student_id in student_ids:
    MessageQueue.publish("notification_tasks", {student_id, message})
    
  return "Notifications queued successfully"

// Worker Process — runs in background, can scale horizontally
function consume_notification_tasks(task):
  try:
    send_email(task.student_id, task.message)
    push_to_app(task.student_id, task.message)
  catch error:
    MessageQueue.retry(task)  // only this specific task gets retried
```

---

## Stage 6: Priority Inbox

When new notifications keep coming in, we don't want to re-sort the entire list every time someone opens their inbox. That doesn't scale.

### How to maintain the top 10 efficiently

I'd use a **Redis Sorted Set (ZSET)**. Heres how it works:

1. When a new notification arrives, calculate a priority score. I'm using: `(type_weight * 10^12) + unix_timestamp`. So a Placement (weight=3) will always rank above a Result (weight=2), and within the same type, newer ones rank higher.

2. Add it to the users sorted set: `ZADD student_123_inbox <score> <notification_id>`

3. When the user wants their top 10: `ZREVRANGE student_123_inbox 0 9` — this returns the 10 highest-scored entries and its O(log N).

4. To keep the set from growing forever, periodically trim it: `ZREMRANGEBYRANK student_123_inbox 0 -101` (keep only the top 100).

This way fetching the priority inbox is always fast regardless of how many total notifications exist.
