import type {
  CodeViewCommentFileByItemId,
  CodeViewDeletedCommentEvent,
  CodeViewSavedCommentEntry,
  CodeViewSavedCommentEvent,
  CodeViewSavedCommentItem,
} from './types';

function insertCommentInLineOrder(
  comments: readonly CodeViewSavedCommentEntry[],
  entry: CodeViewSavedCommentEntry
): CodeViewSavedCommentEntry[] {
  let existingIndex = -1;
  for (let index = 0; index < comments.length; index++) {
    if (comments[index]?.key === entry.key) {
      existingIndex = index;
      break;
    }
  }

  const nextComments =
    existingIndex === -1
      ? [...comments]
      : comments.filter((_, index) => index !== existingIndex);

  let insertIndex = nextComments.length;
  for (let index = 0; index < nextComments.length; index++) {
    const comment = nextComments[index];
    if (comment != null && entry.lineNumber < comment.lineNumber) {
      insertIndex = index;
      break;
    }
  }

  nextComments.splice(insertIndex, 0, entry);
  return nextComments;
}

export function upsertSavedCommentSidebarEntry(
  sections: readonly CodeViewSavedCommentItem[],
  commentFileByItemId: CodeViewCommentFileByItemId | null,
  entry: CodeViewSavedCommentEvent
): CodeViewSavedCommentItem[] {
  const file = commentFileByItemId?.get(entry.itemId);
  if (file == null) {
    return [...sections];
  }

  const nextEntry: CodeViewSavedCommentEntry = {
    author: entry.author,
    itemId: entry.itemId,
    key: entry.key,
    lineNumber: entry.lineNumber,
    lineType: entry.lineType,
    message: entry.message,
    range: entry.range,
    side: entry.side,
  };

  const nextSections = [...sections];
  let sectionIndex = -1;
  for (let index = 0; index < nextSections.length; index++) {
    if (nextSections[index]?.itemId === entry.itemId) {
      sectionIndex = index;
      break;
    }
  }

  if (sectionIndex === -1) {
    const nextSection: CodeViewSavedCommentItem = {
      comments: [nextEntry],
      fileOrder: file.fileOrder,
      itemId: entry.itemId,
      path: file.path,
    };

    let insertIndex = nextSections.length;
    for (let index = 0; index < nextSections.length; index++) {
      const section = nextSections[index];
      if (section != null && file.fileOrder < section.fileOrder) {
        insertIndex = index;
        break;
      }
    }

    nextSections.splice(insertIndex, 0, nextSection);
    return nextSections;
  }

  const section = nextSections[sectionIndex];
  if (section == null) {
    return sections.slice();
  }

  nextSections[sectionIndex] = {
    ...section,
    comments: insertCommentInLineOrder(section.comments, nextEntry),
  };
  return nextSections;
}

export function removeSavedCommentSidebarEntry(
  sections: readonly CodeViewSavedCommentItem[],
  entry: CodeViewDeletedCommentEvent
): CodeViewSavedCommentItem[] {
  let sectionIndex = -1;
  for (let index = 0; index < sections.length; index++) {
    if (sections[index]?.itemId === entry.itemId) {
      sectionIndex = index;
      break;
    }
  }

  if (sectionIndex === -1) {
    return sections.slice();
  }

  const section = sections[sectionIndex];
  if (section == null) {
    return sections.slice();
  }

  const nextComments = section.comments.filter(
    (comment) => comment.key !== entry.key
  );
  if (nextComments.length === section.comments.length) {
    return sections.slice();
  }

  if (nextComments.length === 0) {
    return sections.filter((_, index) => index !== sectionIndex);
  }

  const nextSections = [...sections];
  nextSections[sectionIndex] = {
    ...section,
    comments: nextComments,
  };
  return nextSections;
}
