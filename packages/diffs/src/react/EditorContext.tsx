'use client';

import type { Context, PropsWithChildren } from 'react';
import { createContext, useContext, useEffect } from 'react';

import { Editor as VanillaEditor } from '../editor';

export const EditorContext: Context<VanillaEditor<unknown> | undefined> =
  createContext<VanillaEditor<unknown> | undefined>(undefined);

export function EditorProvider({
  children,
  editor,
}: PropsWithChildren<{ editor: VanillaEditor<unknown> }>): React.JSX.Element {
  useEffect(() => {
    return () => {
      editor.cleanUp();
    };
  }, [editor]);
  return (
    <EditorContext.Provider value={editor}>{children}</EditorContext.Provider>
  );
}

export function useEditor<LAnnotation>():
  | VanillaEditor<LAnnotation>
  | undefined {
  return useContext(EditorContext) as VanillaEditor<LAnnotation> | undefined;
}
