export class Presence {
  constructor(io, store) {
    this.io = io;
    this.store = store;
    this.socketsByUser = new Map();
    this.users = new Map();
  }

  add(socket) {
    const userId = socket.data.user?.id;
    if (!userId) return;
    let sockets = this.socketsByUser.get(userId);
    if (!sockets) {
      sockets = new Set();
      this.socketsByUser.set(userId, sockets);
    }
    sockets.add(socket.id);
    if (!this.users.has(userId)) {
      this.users.set(userId, { since: Date.now() });
    }
    const user = this.store.data.users.find((item) => item.id === userId);
    if (user) {
      user.lastSeenAt = Date.now();
      this.store.save();
    }
    this.broadcast();
  }

  remove(socket) {
    const userId = socket.data.user?.id;
    if (!userId) return;
    const sockets = this.socketsByUser.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) this.socketsByUser.delete(userId);
    }
    if (!this.socketsByUser.has(userId)) {
      this.users.delete(userId);
      const user = this.store.data.users.find((item) => item.id === userId);
      if (user) {
        user.lastSeenAt = Date.now();
        this.store.save();
      }
    }
    this.broadcast();
  }

  list() {
    return [...this.users.entries()].map(([userId, meta]) => ({
      userId,
      since: meta.since,
      connections: this.socketsByUser.get(userId)?.size || 0,
    }));
  }

  isOnline(userId) {
    return this.users.has(userId);
  }

  broadcast() {
    this.io.emit('presence', this.list());
  }

  disconnectUser(userId) {
    const sockets = this.socketsByUser.get(userId);
    if (!sockets) return;
    for (const socketId of [...sockets]) {
      this.io.sockets.sockets.get(socketId)?.disconnect(true);
    }
  }
}
