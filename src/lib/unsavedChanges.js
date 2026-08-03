'use client'

import { createContext, useContext } from 'react'

// Lets a screen with pending edits (the transaction review) flag them so
// Shell's nav links can confirm before discarding — next/link navigation
// doesn't fire beforeunload, so the browser guard alone can't cover it.
export const UnsavedChangesContext = createContext({ dirty: false, setDirty: () => {} })

export const useUnsavedChanges = () => useContext(UnsavedChangesContext)
