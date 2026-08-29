/**
 * ============================================================
 * ShuleSmart — Firestore Compatibility Shim
 * Product by Prince Alex Digital
 * ============================================================
 * Wraps the MODULAR Firestore SDK (getFirestore) in the classic
 * chainable surface (db.collection().where().limit().get(),
 * db.batch(), db.runTransaction()) that the ShuleSmart data
 * engines are written against.
 *
 * Only the surfaces actually used by this project are
 * implemented — deliberately small, easy to audit:
 *   db.collection(name)            -> .doc(id) .add() .where() .limit() .get()
 *   query chaining                 -> .where().where()… .limit(n)
 *   snapshots                      -> forEach / docs / empty / size,
 *                                     doc.id / doc.exists (bool) / doc.data() / doc.ref
 *   document refs                  -> get / set(,{merge}) / update / delete
 *   db.batch()                     -> set / update / delete / commit
 *   db.runTransaction(fn)          -> tx.get / tx.set / tx.update / tx.delete
 * ============================================================
 */

import { db as modularDb } from "./firebase-config.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  query,
  where,
  limit,
  orderBy,
  getCountFromServer,
  writeBatch,
  runTransaction as modularRunTransaction
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/** Accept either a facade wrapper or a raw modular reference. */
function unwrap(ref) {
  return ref && ref._ref ? ref._ref : ref;
}

/* ---------------- document reference ---------------- */
class DocRefFacade {
  constructor(ref) {
    this._ref = ref;
    this.id = ref.id;
  }

  async get() {
    const snap = await getDoc(this._ref);
    return new DocSnapFacade(snap);
  }

  set(data, opts) {
    return opts ? setDoc(this._ref, data, opts) : setDoc(this._ref, data);
  }

  update(data) {
    return updateDoc(this._ref, data);
  }

  delete() {
    return deleteDoc(this._ref);
  }
}

/* ---------------- document snapshot ---------------- */
class DocSnapFacade {
  constructor(snap) {
    this._snap = snap;
    this.id = snap ? snap.id : undefined;
    // Modular exposes exists as a method; expose it as a plain boolean.
    this.exists = snap ? (typeof snap.exists === "function" ? snap.exists() : !!snap.exists) : false;
  }

  data() {
    return this._snap ? this._snap.data() : undefined;
  }

  get ref() {
    return new DocRefFacade(this._snap.ref);
  }
}

/* ---------------- query snapshot ---------------- */
class SnapFacade {
  constructor(qs) {
    this.docs = [];
    qs.forEach((d) => this.docs.push(new DocSnapFacade(d)));
    this.size = this.docs.length;
    this.empty = this.size === 0;
  }

  forEach(cb) {
    this.docs.forEach(cb);
  }
}

/* ---------------- query ---------------- */
/*  NOTE ON OFFSET: the modular web SDK (v9/v10) has no offset() export
 *  (it only existed in the classic v8 API). We emulate it by over-fetching
 *  offset+limit documents and slicing the front off in get(). Billing is
 *  identical — Firestore charges for offset-skipped documents either way. */
class QueryFacade {
  constructor(baseRef, constraints, skip) {
    this._baseRef = baseRef;
    this._constraints = constraints || [];
    this._skip = skip || 0;
  }

  _build() {
    return query(this._baseRef, ...this._constraints);
  }

  where(field, opStr, value) {
    return new QueryFacade(this._baseRef, [...this._constraints, where(field, opStr, value)], this._skip);
  }

  orderBy(field, dir) {
    return new QueryFacade(this._baseRef, [...this._constraints, orderBy(field, dir)], this._skip);
  }

  offset(n) {
    /* No server constraint — remembered and applied as a slice in get(). */
    return new QueryFacade(this._baseRef, [...this._constraints], n);
  }

  limit(n) {
    /* Over-fetch by the pending skip so get() can slice a full page. */
    return new QueryFacade(this._baseRef, [...this._constraints, limit(n + this._skip)], this._skip);
  }

  /** Cheap aggregate count (billed per index entries scanned, not per doc).
   *  Deliberately ignores offset/skip — callers count the whole match set. */
  async count() {
    const snap = await getCountFromServer(this._build());
    return snap.data().count;
  }

  async get() {
    const qs = await getDocs(this._build());
    const snap = new SnapFacade(qs);
    if (this._skip > 0) {
      snap.docs = snap.docs.slice(this._skip);
      snap.size = snap.docs.length;
      snap.empty = snap.size === 0;
    }
    return snap;
  }
}

/* ---------------- collection reference ---------------- */
class CollectionFacade {
  constructor(ref) {
    this._ref = ref;
    this.id = ref.id;
  }

  /** Only the explicit-id form is used by the engines. */
  doc(id) {
    if (id === undefined) throw new Error("firestore-db: doc(id) requires an id.");
    return new DocRefFacade(doc(this._ref, id));
  }

  where(field, opStr, value) {
    return new QueryFacade(this._ref, [where(field, opStr, value)]);
  }

  limit(n) {
    return new QueryFacade(this._ref, [limit(n)]);
  }

  add(data) {
    return addDoc(this._ref, data).then((ref) => new DocRefFacade(ref));
  }

  async get() {
    const qs = await getDocs(collection(this._ref));
    return new SnapFacade(qs);
  }
}

/* ---------------- the wrapped db ---------------- */
const db = {
  /** Raw modular instance, exposed for anything advanced. */
  _modular: modularDb,

  collection(name) {
    return new CollectionFacade(collection(modularDb, name));
  },

  batch() {
    const b = writeBatch(modularDb);
    return {
      set(ref, data, opts) { b.set(unwrap(ref), data, opts); },
      update(ref, data) { b.update(unwrap(ref), data); },
      delete(ref) { b.delete(unwrap(ref)); },
      commit() { return b.commit(); }
    };
  },

  runTransaction(fn) {
    return modularRunTransaction(modularDb, (tx) =>
      fn({
        async get(ref) {
          const snap = await tx.get(unwrap(ref));
          return new DocSnapFacade(snap);
        },
        set(ref, data, opts) {
          if (opts) tx.set(unwrap(ref), data, opts); else tx.set(unwrap(ref), data);
        },
        update(ref, data) { tx.update(unwrap(ref), data); },
        delete(ref) { tx.delete(unwrap(ref)); }
      })
    );
  }
};

export default db;
export { db };