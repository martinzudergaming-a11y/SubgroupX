export interface ActiveTeamRouteLease {
  readonly taskId: string;
  readonly expectedTaskLeaseGeneration: number;
  readonly mailId: string;
  readonly claimToken: string;
  readonly claimGeneration: number;
}
