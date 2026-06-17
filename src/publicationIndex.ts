export interface ClearableCollection<TTarget> {
  clear(): void;
  delete(target: TTarget): void;
}

type PublishedTargetsByProject<TTarget> = Map<string, Map<string, TTarget>>;

export class DiagnosticsPublicationIndex<TTarget> {
  private readonly targetsByProject = new Map<string, Map<string, TTarget>>();

  public clear(collection?: ClearableCollection<TTarget>): void {
    collection?.clear();
    this.targetsByProject.clear();
  }

  /**
   * Delete only the targets currently tracked by this index from the
   * collection, without clearing targets that were published outside the
   * index (e.g. direct-run manual diagnostics).
   */
  public deleteKnownTargets(collection: ClearableCollection<TTarget>): void {
    for (const targets of this.targetsByProject.values()) {
      for (const target of targets.values()) {
        collection.delete(target);
      }
    }
    this.targetsByProject.clear();
  }

  public replaceAll(
    collection: ClearableCollection<TTarget>,
    nextTargetsByProject: PublishedTargetsByProject<TTarget>,
  ): void {
    collection.clear();
    this.targetsByProject.clear();

    for (const [projectKey, targets] of nextTargetsByProject.entries()) {
      this.targetsByProject.set(projectKey, new Map(targets));
    }
  }

  public replaceProjects(
    collection: ClearableCollection<TTarget>,
    projectKeys: Iterable<string>,
    nextTargetsByProject: PublishedTargetsByProject<TTarget>,
  ): void {
    for (const projectKey of projectKeys) {
      const previousTargets = this.targetsByProject.get(projectKey);
      if (previousTargets) {
        for (const target of previousTargets.values()) {
          collection.delete(target);
        }
      }

      const nextTargets = nextTargetsByProject.get(projectKey);
      if (nextTargets && nextTargets.size > 0) {
        this.targetsByProject.set(projectKey, new Map(nextTargets));
      } else {
        this.targetsByProject.delete(projectKey);
      }
    }
  }

  public getPublishedTargetKeys(projectKey: string): string[] {
    return [...(this.targetsByProject.get(projectKey)?.keys() ?? [])].sort();
  }
}