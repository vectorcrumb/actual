import React, { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, Ref } from 'react';
import { AutoSizer } from 'react-virtualized-auto-sizer';

import { SpaceBetween } from '@actual-app/components/space-between';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import * as monthUtils from '@actual-app/core/shared/months';
import { integerToCurrency } from '@actual-app/core/shared/util';
import {
  differenceInCalendarDays,
  eachDayOfInterval,
  eachMonthOfInterval,
  format,
  subDays,
  subMonths,
} from 'date-fns';
import { Area, AreaChart, Tooltip as RechartsTooltip, YAxis } from 'recharts';

import { PrivacyFilter } from '#components/PrivacyFilter';
import { useRechartsAnimation } from '#components/reports/chart-theme';
import { LoadingIndicator } from '#components/reports/LoadingIndicator';
import { useLocale } from '#hooks/useLocale';
import * as query from '#queries';
import { liveQuery } from '#queries/liveQuery';

const LABEL_WIDTH = 70;

type BalanceHistoryGraphProps = {
  accountId?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
  granularity?: 'day' | 'month';
  startDate?: Date;
  endDate?: Date;
};

export function BalanceHistoryGraph({
  accountId,
  style,
  ref,
  granularity = 'month',
  startDate: startDateProp,
  endDate: endDateProp,
}: BalanceHistoryGraphProps) {
  const locale = useLocale();
  const animationProps = useRechartsAnimation({ isAnimationActive: false });
  const [balanceData, setBalanceData] = useState<
    Array<{ date: string; balance: number }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [hoveredValue, setHoveredValue] = useState<{
    date: string;
    balance: number;
  } | null>(null);
  const [startingBalance, setStartingBalance] = useState<number | null>(null);
  const [monthlyTotals, setMonthlyTotals] = useState<Array<{
    date: string;
    balance: number;
  }> | null>(null);

  const percentageChange = useMemo(() => {
    if (balanceData.length < 2) return 0;
    const firstBalance = balanceData[0].balance;
    const lastBalance = balanceData[balanceData.length - 1].balance;
    if (firstBalance === 0) return 0;
    return ((lastBalance - firstBalance) / Math.abs(firstBalance)) * 100;
  }, [balanceData]);
  const color = useMemo(
    () => (percentageChange >= 0 ? theme.noticeTextLight : theme.errorText),
    [percentageChange],
  );

  useEffect(() => {
    // Reset state when accountId or range changes
    setStartingBalance(null);
    setMonthlyTotals(null);
    setLoading(true);

    const endDate = endDateProp ?? new Date();
    const startDate =
      startDateProp ??
      (granularity === 'day' ? subDays(endDate, 30) : subMonths(endDate, 12));

    const rangeStartDay = monthUtils.dayFromDate(startDate);
    const rangeEndDay = monthUtils.dayFromDate(endDate);

    const startingBalanceQuery = query
      .transactions(accountId)
      .filter({
        date: { $lt: rangeStartDay },
      })
      .calculate({ $sum: '$amount' });

    const periodTotalsQuery =
      granularity === 'day'
        ? query
            .transactions(accountId)
            .filter({
              $and: [
                { date: { $gte: rangeStartDay } },
                { date: { $lte: rangeEndDay } },
              ],
            })
            .groupBy({ $day: '$date' })
            .select([
              { date: { $day: '$date' } },
              { amount: { $sum: '$amount' } },
            ])
        : query
            .transactions(accountId)
            .filter({
              $and: [
                { date: { $gte: monthUtils.firstDayOfMonth(startDate) } },
                { date: { $lte: monthUtils.lastDayOfMonth(endDate) } },
              ],
            })
            .groupBy({ $month: '$date' })
            .select([
              { date: { $month: '$date' } },
              { amount: { $sum: '$amount' } },
            ]);

    const startingBalanceLive: ReturnType<typeof liveQuery<number>> = liveQuery(
      startingBalanceQuery,
      {
        onData: (data: number[]) => {
          setStartingBalance(data[0] || 0);
        },
        onError: error => {
          console.error('Error fetching starting balance:', error);
          setLoading(false);
        },
      },
    );

    const monthlyTotalsLive: ReturnType<
      typeof liveQuery<{ date: string; amount: number }>
    > = liveQuery(periodTotalsQuery, {
      onData: (data: Array<{ date: string; amount: number }>) => {
        setMonthlyTotals(
          data.map(d => ({
            date: d.date,
            balance: d.amount,
          })),
        );
      },
      onError: error => {
        console.error('Error fetching period totals:', error);
        setLoading(false);
      },
    });

    return () => {
      startingBalanceLive?.unsubscribe();
      monthlyTotalsLive?.unsubscribe();
    };
  }, [accountId, granularity, startDateProp, endDateProp, locale]);

  // Process data when both startingBalance and monthlyTotals are available
  useEffect(() => {
    if (startingBalance !== null && monthlyTotals !== null) {
      const endDate = endDateProp ?? new Date();
      const startDate =
        startDateProp ??
        (granularity === 'day' ? subDays(endDate, 30) : subMonths(endDate, 12));

      const periods =
        granularity === 'day'
          ? eachDayOfInterval({ start: startDate, end: endDate }).map(d =>
              format(d, 'yyyy-MM-dd'),
            )
          : eachMonthOfInterval({ start: startDate, end: endDate }).map(m =>
              format(m, 'yyyy-MM'),
            );

      function processData(
        startingBalanceValue: number,
        periodTotalsValue: Array<{ date: string; balance: number }>,
      ) {
        let currentBalance = startingBalanceValue;
        const totals = [...periodTotalsValue];
        totals.reverse().forEach(period => {
          currentBalance = currentBalance + period.balance;
          period.balance = currentBalance;
        });

        // if the account doesn't have recent transactions
        // then the empty periods will be missing from our data
        // so add in entries for those here
        if (totals.length === 0) {
          periods.forEach(expectedPeriod =>
            totals.push({
              date: expectedPeriod,
              balance: startingBalanceValue,
            }),
          );
        } else if (totals.length < periods.length) {
          // iterate through each array together and add in missing data
          let totalsIndex = 0;
          let mostRecent = startingBalanceValue;
          periods.forEach(expectedPeriod => {
            if (totalsIndex > totals.length - 1) {
              // fill in the data at the end of the window
              totals.push({
                date: expectedPeriod,
                balance: mostRecent,
              });
            } else if (totals[totalsIndex].date === expectedPeriod) {
              // a matched period
              mostRecent = totals[totalsIndex].balance;
              totalsIndex += 1;
            } else {
              // a missing period in the middle
              totals.push({
                date: expectedPeriod,
                balance: mostRecent,
              });
            }
          });
        }

        const dateFormat =
          granularity === 'day' ? 'MMM d yyyy' : 'MMM yyyy';
        const balances = totals
          .sort((a, b) =>
            granularity === 'day'
              ? differenceInCalendarDays(
                  monthUtils._parse(a.date),
                  monthUtils._parse(b.date),
                )
              : monthUtils.differenceInCalendarMonths(a.date, b.date),
          )
          .map(t => ({
            balance: t.balance,
            date: monthUtils.format(t.date, dateFormat, locale),
          }));

        setBalanceData(balances);
        setHoveredValue(balances[balances.length - 1]);
        setLoading(false);
      }

      processData(startingBalance, monthlyTotals);
    }
  }, [
    startingBalance,
    monthlyTotals,
    granularity,
    startDateProp,
    endDateProp,
    locale,
  ]);

  // State to track if the chart is hovered (used to conditionally render PrivacyFilter)
  const [isHovered, setIsHovered] = useState(false);

  return (
    <View ref={ref} style={{ margin: 10, ...style }}>
      <AutoSizer
        renderProp={({ width = 0, height = 0 }) => {
          if (width === 0 || height === 0) {
            return null;
          }

          if (loading) {
            return (
              <div style={{ width, height }}>
                <LoadingIndicator />
              </div>
            );
          }

          return (
            <View style={{ width }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'stretch',
                  justifyContent: 'space-between',
                }}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
              >
                <AreaChart
                  data={balanceData}
                  width={width - LABEL_WIDTH}
                  height={height}
                >
                  <defs>
                    <linearGradient
                      id="fillLight"
                      x1="0.9"
                      y1="0"
                      x2="0.3"
                      y2="1"
                    >
                      <stop stopColor={theme.noticeTextLight} stopOpacity={1} />
                      <stop
                        offset="90%"
                        stopColor={theme.noticeTextLight}
                        stopOpacity={0.2}
                      />
                    </linearGradient>
                    <linearGradient
                      id="fillError"
                      x1="0.9"
                      y1="0"
                      x2="0.3"
                      y2="1"
                    >
                      <stop stopColor={theme.errorText} stopOpacity={1} />
                      <stop
                        offset="90%"
                        stopColor={theme.errorText}
                        stopOpacity={0.2}
                      />
                    </linearGradient>
                  </defs>
                  <YAxis domain={['dataMin', 'dataMax']} hide />
                  <RechartsTooltip
                    contentStyle={{
                      display: 'none',
                    }}
                    labelFormatter={(label, items) => {
                      const data = items[0]?.payload;
                      if (data) {
                        setHoveredValue(data);
                      }
                      return '';
                    }}
                    isAnimationActive={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="balance"
                    stroke={color}
                    strokeWidth={2}
                    {...animationProps}
                    fill={
                      color === theme.noticeTextLight
                        ? 'url(#fillLight)'
                        : 'url(#fillError)'
                    }
                  />
                </AreaChart>

                <SpaceBetween
                  direction="vertical"
                  style={{
                    alignItems: 'flex-end',
                    justifyContent: 'space-between',
                    width: LABEL_WIDTH,
                    textAlign: 'right',
                    ...styles.verySmallText,
                  }}
                >
                  {percentageChange === 0 ? (
                    <div />
                  ) : (
                    <Text style={{ color }}>
                      {percentageChange >= 0 ? '+' : ''}
                      {percentageChange.toFixed(1)}%
                    </Text>
                  )}

                  {hoveredValue && (
                    <View>
                      <Text style={{ fontWeight: 800 }}>
                        {hoveredValue.date}
                      </Text>
                      <PrivacyFilter activationFilters={[() => !isHovered]}>
                        <Text>{integerToCurrency(hoveredValue.balance)}</Text>
                      </PrivacyFilter>
                    </View>
                  )}
                </SpaceBetween>
              </div>
            </View>
          );
        }}
      />
    </View>
  );
}
