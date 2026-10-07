// Stable keys preserve task identity even when the auditor renames a task.
export const DEFAULT_ENGAGEMENT_TASKS = [
  { templateKey: 'DOCUMENT', title: 'Document' },
  { templateKey: 'VAT_RECO', title: 'Vat Reco' },
  { templateKey: 'SALES_RECO', title: 'Sales Reco' },
  { templateKey: 'PURCHASE_RECO', title: 'Purchase Reco' },
  { templateKey: 'SALES_CONFIRMATION', title: 'Sales Confirmation' },
  { templateKey: 'PURCHASE_CONFIRMATION', title: 'Purchase Confirmation' },
] as const;

export function isRequiredTask(templateKey: string | null | undefined) {
  return DEFAULT_ENGAGEMENT_TASKS.some(
    (task) => task.templateKey === templateKey,
  );
}

export function defaultEngagementTasks(assignedToId: string) {
  return DEFAULT_ENGAGEMENT_TASKS.map((task, index) => ({
    ...task,
    assignedToId,
    sortOrder: index + 1,
  }));
}
